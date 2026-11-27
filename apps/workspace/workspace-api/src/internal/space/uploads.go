package space

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/httpx"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/orchestrator"
)

const (
	spaceQuota      = 200_000_000
	spaceFileLimit  = 100_000_000
	spacePartSize   = 16 * 1024 * 1024
	spaceUploadLife = 24 * time.Hour
	spaceLiveStates = "('preparing','uploading','completing','cleaning','saved','deleting')"
)

type uploadStorage interface {
	abort(context.Context, string, string) error
	create(context.Context, string) (string, error)
	signPart(context.Context, string, string, int32, int64, string) (string, error)
	parts(context.Context, string, string) ([]types.Part, bool, error)
	size(context.Context, string) (int64, bool, error)
	complete(context.Context, string, string, []types.CompletedPart) error
	empty(context.Context, string) error
	remove(context.Context, string) error
}

type spaceUploads struct {
	db      *sql.DB
	storage uploadStorage
	now     func() time.Time
}

type spaceUpload struct {
	spaceUploadView
	owner, manifest string
	storageID       sql.NullString
	cleanup         sql.NullString
	signedUntil     int64
}

type uploadReservation struct {
	id, path string
	size     int64
	manifest string
}

func invalidSpace(message string) *httpx.Error {
	return httpx.NewError(400, "invalid_space_input", message)
}

func spaceConflict(message string) *httpx.Error {
	return httpx.NewError(409, "space_conflict", message)
}

func parseUploadReservation(fields map[string]json.RawMessage) (uploadReservation, error) {
	id, _ := httpx.String(fields["id"])
	if !orchestrator.ValidTaskID(id) {
		return uploadReservation{}, httpx.NotFound
	}
	path, ok := httpx.WellFormedString(fields["path"])
	if !ok || len(utf16.Encode([]rune(path))) > 1024 ||
		strings.ContainsRune(path, 92) || strings.ContainsFunc(path, unicode.IsControl) {
		return uploadReservation{}, invalidSpace("文件路径无效。")
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return uploadReservation{}, invalidSpace("文件路径无效。")
		}
	}
	number, ok := httpx.Integer(fields["size"], 0)
	if !ok {
		return uploadReservation{}, invalidSpace("文件大小无效。")
	}
	size := number
	if size > spaceFileLimit {
		return uploadReservation{}, httpx.NewError(413, "file_limit", "单文件最多 100 MB。")
	}
	var checksums []json.RawMessage
	if json.Unmarshal(fields["checksums"], &checksums) != nil || checksums == nil ||
		int64(len(checksums)) != (size+spacePartSize-1)/spacePartSize {
		return uploadReservation{}, invalidSpace("分块摘要清单无效。")
	}
	manifest := make([]string, 0, len(checksums))
	for _, raw := range checksums {
		value, ok := httpx.String(raw)
		digest, err := base64.StdEncoding.Strict().DecodeString(value)
		if !ok || err != nil || len(digest) != 32 || base64.StdEncoding.EncodeToString(digest) != value {
			return uploadReservation{}, invalidSpace("分块摘要清单无效。")
		}
		manifest = append(manifest, value)
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return uploadReservation{}, err
	}
	return uploadReservation{id: id, path: path, size: size, manifest: string(encoded)}, nil
}

type spaceUploadQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadSpaceUpload(ctx context.Context, db spaceUploadQuery, id string) (spaceUpload, error) {
	var row spaceUpload
	err := db.QueryRowContext(ctx, `
		SELECT id,project,owner,path,size,manifest,state,storageId,expires,signedUntil,cleanup
		FROM space_uploads WHERE id=?`, id).
		Scan(&row.ID, &row.Project, &row.owner, &row.Path, &row.Size, &row.manifest, &row.State,
			&row.storageID, &row.Expires, &row.signedUntil, &row.cleanup)
	return row, err
}

func (s spaceUploads) reserve(ctx context.Context, owner, project string, input uploadReservation) (spaceUpload, error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return spaceUpload{}, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return spaceUpload{}, err
	}
	defer func() { _, _ = conn.ExecContext(context.WithoutCancel(ctx), "ROLLBACK") }()
	var exists, blocked, retired bool
	err = conn.QueryRowContext(ctx, `
		SELECT EXISTS(SELECT 1 FROM space_projects WHERE id=? AND owner=?),
		       (EXISTS(SELECT 1 FROM space_project_deletions WHERE owner=? AND spaceId=?)
		        OR EXISTS(SELECT 1 FROM space_draining_owners WHERE owner=?)),
		       EXISTS(SELECT 1 FROM space_retired_upload_ids WHERE id=?)`,
		project, owner, owner, project, owner, input.id).Scan(&exists, &blocked, &retired)
	if err != nil {
		return spaceUpload{}, err
	}
	if !exists {
		return spaceUpload{}, httpx.NotFound
	}
	if blocked {
		return spaceUpload{}, httpx.NewError(409, "project_busy", "项目仍有未结束的任务或正在清理。")
	}
	if retired {
		return spaceUpload{}, httpx.NotFound
	}
	row, err := loadSpaceUpload(ctx, conn, input.id)
	if err == nil {
		if row.owner != owner {
			return spaceUpload{}, httpx.NotFound
		}
		if row.State == "deleting" || row.State == "deleted" {
			return spaceUpload{}, spaceConflict("该文件正在删除或已删除，请重新选择文件。")
		}
		if row.Project != project || row.Path != input.path || row.Size != input.size || row.manifest != input.manifest {
			return spaceUpload{}, spaceConflict("同一上传编号对应不同文件。")
		}
	} else if errors.Is(err, sql.ErrNoRows) {
		var collision bool
		var used int64
		err = conn.QueryRowContext(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM space_uploads WHERE project=? AND state IN `+spaceLiveStates+`
				AND (path=? OR instr(path,? || '/')=1 OR instr(?,path || '/')=1)
			), coalesce((SELECT sum(size) FROM space_uploads WHERE owner=? AND state IN `+spaceLiveStates+`),0)`,
			project, input.path, input.path, input.path, owner).Scan(&collision, &used)
		if err != nil {
			return spaceUpload{}, err
		}
		if collision {
			return spaceUpload{}, spaceConflict("目标路径已有文件或上传。")
		}
		if used+input.size > spaceQuota {
			return spaceUpload{}, httpx.NewError(409, "space_quota", "账号空间不足，已保存和上传预占合计最多 200 MB。")
		}
		expires := s.now().Add(spaceUploadLife).UnixMilli()
		_, err = conn.ExecContext(ctx, `
			INSERT INTO space_uploads (id,project,owner,path,size,manifest,state,expires)
			VALUES (?,?,?,?,?,?,'preparing',?)`,
			input.id, project, owner, input.path, input.size, input.manifest, expires)
		if err != nil {
			return spaceUpload{}, err
		}
		row = spaceUpload{
			spaceUploadView: spaceUploadView{
				ID: input.id, Project: project, Path: input.path, Size: input.size, State: "preparing", Expires: expires,
			},
			owner: owner, manifest: input.manifest,
		}
	} else {
		return spaceUpload{}, err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return row, err
}

func (s spaceUploads) transition(ctx context.Context, row *spaceUpload, state string) error {
	result, err := s.db.ExecContext(ctx, "UPDATE space_uploads SET state=? WHERE id=? AND owner=? AND state=?",
		state, row.ID, row.owner, row.State)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return spaceConflict("操作处理中，请稍后查看状态。")
	}
	row.State = state
	return nil
}

// Object operations require the caller to serialize work for this upload ID,
// including the periodic cleanup and deletion paths.
func (s spaceUploads) prepare(ctx context.Context, row *spaceUpload) error {
	if row.State != "preparing" {
		return nil
	}
	if row.Expires <= s.now().UnixMilli() {
		return spaceConflict("上传已过期。")
	}
	var storageID sql.NullString
	if row.Size > 0 {
		key := spaceObjectKey(row.ID)
		if err := s.storage.abort(ctx, key, ""); err != nil {
			return err
		}
		id, err := s.storage.create(ctx, key)
		if err != nil {
			return err
		}
		storageID = sql.NullString{String: id, Valid: true}
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE space_uploads SET state='uploading',storageId=? WHERE id=? AND owner=? AND state='preparing'`,
		storageID, row.ID, row.owner)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return spaceConflict("操作处理中，请稍后查看状态。")
	}
	row.State, row.storageID = "uploading", storageID
	return nil
}

func (row spaceUpload) partBytes(number int32) int64 {
	return min(spacePartSize, row.Size-int64(number-1)*spacePartSize)
}

func (row spaceUpload) checksums() ([]string, error) {
	var checksums []string
	err := json.Unmarshal([]byte(row.manifest), &checksums)
	return checksums, err
}

func (s spaceUploads) completedParts(ctx context.Context, row spaceUpload) ([]types.CompletedPart, bool, error) {
	completed := []types.CompletedPart{}
	if !row.storageID.Valid {
		return completed, true, nil
	}
	checksums, err := row.checksums()
	if err != nil {
		return nil, false, err
	}
	parts, exists, err := s.storage.parts(ctx, spaceObjectKey(row.ID), row.storageID.String)
	if err != nil || !exists {
		return nil, exists, err
	}
	for _, part := range parts {
		number := aws.ToInt32(part.PartNumber)
		if number < 1 || int(number) > len(checksums) || aws.ToString(part.ETag) == "" ||
			aws.ToInt64(part.Size) != row.partBytes(number) ||
			aws.ToString(part.ChecksumSHA256) != checksums[number-1] {
			continue
		}
		completed = append(completed, types.CompletedPart{
			PartNumber: part.PartNumber, ETag: part.ETag, ChecksumSHA256: aws.String(checksums[number-1]),
		})
	}
	sort.Slice(completed, func(i, j int) bool { return *completed[i].PartNumber < *completed[j].PartNumber })
	return completed, true, nil
}

func (s spaceUploads) signPart(ctx context.Context, row *spaceUpload, number int32) (string, string, error) {
	if err := s.prepare(ctx, row); err != nil {
		return "", "", err
	}
	if row.State != "uploading" || !row.storageID.Valid || row.Expires <= s.now().UnixMilli() {
		return "", "", spaceConflict("上传不可继续。")
	}
	checksums, err := row.checksums()
	if err != nil {
		return "", "", err
	}
	if number < 1 || int(number) > len(checksums) {
		return "", "", invalidSpace("分块编号无效。")
	}
	checksum := checksums[number-1]
	if checksum == "" {
		return "", "", invalidSpace("分块摘要无效。")
	}
	signed, err := s.storage.signPart(ctx, spaceObjectKey(row.ID), row.storageID.String, number, row.partBytes(number), checksum)
	if err != nil {
		return "", "", err
	}
	until := s.now().Add(partURLLifetime + 5*time.Second).UnixMilli()
	result, err := s.db.ExecContext(ctx, `
		UPDATE space_uploads SET signedUntil=max(signedUntil,?) WHERE id=? AND owner=? AND state='uploading'`,
		until, row.ID, row.owner)
	if err != nil {
		return "", "", err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return "", "", err
	}
	if changed != 1 {
		return "", "", spaceConflict("上传不可继续。")
	}
	row.signedUntil = max(row.signedUntil, until)
	return signed, checksum, nil
}

func (s spaceUploads) finish(ctx context.Context, row *spaceUpload) error {
	switch row.State {
	case "saved":
		return nil
	case "uploading":
		if row.Expires <= s.now().UnixMilli() {
			return spaceConflict("上传已过期。")
		}
		if err := s.transition(ctx, row, "completing"); err != nil {
			return err
		}
	case "completing":
	default:
		return spaceConflict("此上传无法完成。")
	}
	key := spaceObjectKey(row.ID)
	actual, found, err := s.storage.size(ctx, key)
	if err != nil {
		return err
	}
	if !found && row.storageID.Valid {
		parts, exists, err := s.completedParts(ctx, *row)
		if err != nil {
			return err
		}
		checksums, err := row.checksums()
		if err != nil {
			return err
		}
		complete := exists && len(parts) == len(checksums)
		for i, part := range parts {
			complete = complete && *part.PartNumber == int32(i+1)
		}
		if complete {
			if err := s.storage.complete(ctx, key, row.storageID.String, parts); err != nil {
				return err
			}
		} else {
			actual, found, err = s.storage.size(ctx, key)
			if err != nil {
				return err
			}
			if !found {
				if err := s.transition(ctx, row, "uploading"); err != nil {
					return err
				}
				return spaceConflict("分块未齐，请补传后重试。")
			}
		}
	} else if !found {
		if err := s.storage.empty(ctx, key); err != nil {
			return err
		}
	}
	if !found {
		actual, found, err = s.storage.size(ctx, key)
		if err != nil {
			return err
		}
		if !found {
			return errors.New("stored object not visible")
		}
	}
	if actual != row.Size {
		if err := s.clean(ctx, row, "failed"); err != nil {
			return err
		}
		return spaceConflict("存储文件大小不符，上传已停止。")
	}
	return s.transition(ctx, row, "saved")
}

func (s spaceUploads) clean(ctx context.Context, row *spaceUpload, outcome string) error {
	if row.State != "cleaning" {
		result, err := s.db.ExecContext(ctx, `
			UPDATE space_uploads SET state='cleaning',cleanup=? WHERE id=? AND owner=? AND state=?`,
			outcome, row.ID, row.owner, row.State)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return spaceConflict("操作处理中，请稍后查看状态。")
		}
		row.State, row.cleanup = "cleaning", sql.NullString{String: outcome, Valid: true}
	}
	if row.signedUntil > s.now().UnixMilli() {
		return nil
	}
	key := spaceObjectKey(row.ID)
	if row.Size > 0 {
		if err := s.storage.abort(ctx, key, row.storageID.String); err != nil {
			return err
		}
	}
	if _, exists, err := s.storage.size(ctx, key); err != nil {
		return err
	} else if exists {
		if err := s.storage.remove(ctx, key); err != nil {
			return err
		}
	}
	if row.cleanup.Valid {
		outcome = row.cleanup.String
	}
	return s.transition(ctx, row, outcome)
}
