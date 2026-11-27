package space

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/httpx"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/orchestrator"
)

type spaceSnapshots struct {
	db      *sql.DB
	read    func(context.Context, string, int64) ([]byte, error)
	backend orchestrator.Client
}

type snapshotIssue struct {
	FileID string `json:"fileId"`
	Path   string `json:"path"`
	Code   string `json:"code"`
}

type snapshotFailure struct {
	Failure *httpx.Error
	Issues  []snapshotIssue
}

func (f *snapshotFailure) HTTPDetails() (*httpx.Error, any) {
	if len(f.Issues) == 0 {
		return f.Failure, nil
	}
	return f.Failure, f.Issues
}

func (f *snapshotFailure) Error() string { return f.Failure.Error() }

type snapshotManifestEntry struct {
	FileID string `json:"fileId"`
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

func validSnapshotPath(path string) bool {
	if !utf8.ValidString(path) || len(path) > 4096 || strings.ContainsRune(path, 92) || strings.ContainsFunc(path, unicode.IsControl) {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." || strings.EqualFold(part, ".git") || len(part) > 255 {
			return false
		}
	}
	return true
}

// Match JSON.stringify for the ordered file snapshot used to compute inputDigest.
func snapshotJSON(files []orchestrator.ProjectFile) []byte {
	var result bytes.Buffer
	result.WriteByte('[')
	for i, file := range files {
		if i != 0 {
			result.WriteByte(',')
		}
		result.WriteString(`{"path":`)
		appendSnapshotString(&result, file.Path)
		result.WriteString(`,"text":`)
		appendSnapshotString(&result, file.Text)
		result.WriteByte('}')
	}
	result.WriteByte(']')
	return result.Bytes()
}

func appendSnapshotString(result *bytes.Buffer, value string) {
	const hexDigits = "0123456789abcdef"
	result.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"', 92:
			result.WriteByte(92)
			result.WriteRune(character)
		case 8:
			result.WriteString(`\b`)
		case 9:
			result.WriteString(`\t`)
		case 10:
			result.WriteString(`\n`)
		case 12:
			result.WriteString(`\f`)
		case 13:
			result.WriteString(`\r`)
		default:
			if character < 32 {
				result.WriteString(`\u00`)
				result.WriteByte(hexDigits[character>>4])
				result.WriteByte(hexDigits[character&15])
			} else {
				result.WriteRune(character)
			}
		}
	}
	result.WriteByte('"')
}

func (s spaceSnapshots) freeze(ctx context.Context, owner, id string) error {
	var name, space, fileIDs, state string
	err := s.db.QueryRowContext(ctx, `
		SELECT name,spaceId,fileIds,state FROM space_tasks WHERE id=? AND owner=?`, id, owner).
		Scan(&name, &space, &fileIDs, &state)
	if errors.Is(err, sql.ErrNoRows) {
		return httpx.NotFound
	}
	if err != nil {
		return err
	}
	if state != "pinned" {
		return nil
	}
	var ids []string
	if err := json.Unmarshal([]byte(fileIDs), &ids); err != nil {
		return err
	}
	if len(ids) > 100 {
		return httpx.NewError(413, "too_large", "任务快照最多 100 个文件。")
	}
	var size int64
	var oversized []snapshotIssue
	selected := make([]spaceUpload, 0, len(ids))
	for _, file := range ids {
		var row spaceUpload
		row.ID = file
		err := s.db.QueryRowContext(ctx, `
			SELECT u.path,u.size,u.manifest FROM space_uploads u
			WHERE u.id=? AND u.owner=? AND u.project=? AND u.state='saved'
			AND NOT EXISTS(SELECT 1 FROM space_file_deletions d WHERE d.fileId=u.id)`, file, owner, space).
			Scan(&row.Path, &row.Size, &row.manifest)
		if errors.Is(err, sql.ErrNoRows) {
			return httpx.NotFound
		}
		if err != nil {
			return err
		}
		selected = append(selected, row)
		size += row.Size
		if row.Size > 1024*1024 {
			oversized = append(oversized, snapshotIssue{file, row.Path, "too_large"})
		}
	}
	if size > 1024*1024 {
		return &snapshotFailure{httpx.NewError(413, "too_large", "任务快照的文本总量不能超过 1 MiB。"), oversized}
	}
	files := make([]orchestrator.ProjectFile, 0, len(ids))
	manifest := make([]snapshotManifestEntry, 0, len(ids))
	var issues []snapshotIssue
	for _, row := range selected {
		if !validSnapshotPath(row.Path) {
			issues = append(issues, snapshotIssue{row.ID, row.Path, "invalid_path"})
			continue
		}
		data, err := s.read(ctx, spaceObjectKey(row.ID), row.Size)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(data)
		if row.Size != int64(len(data)) {
			return errors.New("saved file size mismatch")
		}
		if row.Size > 0 {
			checksums, err := row.checksums()
			if err != nil || len(checksums) != 1 || base64.StdEncoding.EncodeToString(digest[:]) != checksums[0] {
				return errors.New("saved file checksum mismatch")
			}
		}
		if !utf8.Valid(data) {
			issues = append(issues, snapshotIssue{row.ID, row.Path, "invalid_utf8"})
			continue
		}
		files = append(files, orchestrator.ProjectFile{Path: row.Path, Text: string(data)})
		manifest = append(manifest, snapshotManifestEntry{row.ID, row.Path, row.Size, hex.EncodeToString(digest[:])})
	}
	if len(issues) != 0 {
		return &snapshotFailure{httpx.NewError(400, "invalid_input", "请调整所选文件后重试。"), issues}
	}

	for _, file := range files {
		for _, other := range files {
			if strings.HasPrefix(other.Path, file.Path+"/") {
				return httpx.NewError(400, "path_conflict", "文件路径和目录路径冲突。")
			}
		}
	}
	slices.SortFunc(files, func(a, b orchestrator.ProjectFile) int {
		return slices.Compare(utf16.Encode([]rune(a.Path)), utf16.Encode([]rune(b.Path)))
	})
	digest := sha256.Sum256(snapshotJSON(files))
	body, err := json.Marshal(map[string]any{
		"id": id, "name": name, "sourceSpaceId": space,
		"inputFiles": files, "inputManifest": manifest, "inputDigest": hex.EncodeToString(digest[:]),
	})
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, "UPDATE space_tasks SET state='frozen',canonicalBody=? WHERE id=? AND owner=? AND state='pinned'",
		string(body), id, owner)
	return err
}

type Selection struct {
	Kind    string   `json:"kind"`
	SpaceID string   `json:"spaceId"`
	FileIDs []string `json:"fileIds"`
}

func (s spaceSnapshots) enroll(ctx context.Context, owner, key, name string, source Selection) error {
	if !orchestrator.ValidTaskID(key) ||
		source.Kind != "space_snapshot" || len(source.FileIDs) == 0 || len(source.FileIDs) > 100 ||
		strings.TrimSpace(name) != name || name == "" || utf8.RuneCountInString(name) > 120 {
		return httpx.InvalidTask
	}
	if !orchestrator.ValidTaskID(source.SpaceID) {
		return httpx.NotFound
	}
	for i, id := range source.FileIDs {
		if !orchestrator.ValidTaskID(id) {
			return httpx.NotFound
		}
		if i > 0 && source.FileIDs[i-1] >= id {
			return httpx.InvalidTask
		}
	}
	fileIDs, err := json.Marshal(source.FileIDs)
	if err != nil {
		return err
	}
	var canonical bytes.Buffer
	canonical.WriteString(`{"name":`)
	appendSnapshotString(&canonical, name)
	canonical.WriteString(`,"source":{"kind":"space_snapshot","spaceId":`)
	appendSnapshotString(&canonical, source.SpaceID)
	canonical.WriteString(`,"fileIds":`)
	canonical.Write(fileIDs)
	canonical.WriteString("}}")
	digest := sha256.Sum256(canonical.Bytes())
	hash := hex.EncodeToString(digest[:])

	return spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
		var prior string
		err := conn.QueryRowContext(ctx, "SELECT hash FROM space_tasks WHERE owner=? AND key=?", owner, key).Scan(&prior)
		if err == nil {
			if prior != hash {
				return httpx.NewError(409, "idempotency_conflict", "提交键已用于其他输入。")
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		var blocked, projectExists bool
		err = conn.QueryRowContext(ctx, `
			SELECT EXISTS(SELECT 1 FROM space_project_deletions WHERE owner=? AND spaceId=?)
				OR EXISTS(SELECT 1 FROM space_draining_owners WHERE owner=?),
				EXISTS(SELECT 1 FROM space_projects WHERE owner=? AND id=?)`,
			owner, source.SpaceID, owner, owner, source.SpaceID).Scan(&blocked, &projectExists)
		if err != nil {
			return err
		}
		if blocked {
			return httpx.NewError(409, "project_busy", "项目仍有未结束的任务或正在清理。")
		}
		if !projectExists {
			return httpx.NotFound
		}
		var total int64
		var oversized []snapshotIssue
		for _, file := range source.FileIDs {
			var path string
			var bytes int64
			err := conn.QueryRowContext(ctx, `
				SELECT u.path,u.size FROM space_uploads u
				WHERE u.owner=? AND u.project=? AND u.id=? AND u.state='saved'
				AND NOT EXISTS(SELECT 1 FROM space_file_deletions d WHERE d.fileId=u.id)`,
				owner, source.SpaceID, file).Scan(&path, &bytes)
			if errors.Is(err, sql.ErrNoRows) {
				return httpx.NotFound
			}
			if err != nil {
				return err
			}
			total += bytes
			if bytes > 1024*1024 {
				oversized = append(oversized, snapshotIssue{file, path, "too_large"})
			}
		}
		if total > 1024*1024 {
			return &snapshotFailure{httpx.NewError(413, "too_large", "任务快照的文本总量不能超过 1 MiB。"), oversized}
		}
		task, err := uuid.NewRandom()
		if err != nil {
			return err
		}
		_, err = conn.ExecContext(ctx, `
			INSERT INTO space_tasks (id,owner,spaceId,key,hash,name,fileIds,state)
			VALUES (?,?,?,?,?,?,?,'pinned')`, task.String(), owner, source.SpaceID, key, hash, name, string(fileIDs))
		if err != nil {
			return err
		}
		for _, file := range source.FileIDs {
			if _, err := conn.ExecContext(ctx, "INSERT INTO space_task_inputs VALUES (?,?,1)", task.String(), file); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s spaceSnapshots) create(w http.ResponseWriter, r *http.Request, owner, key, name string, source Selection) error {
	ctx := r.Context()
	if err := s.enroll(ctx, owner, key, name, source); err != nil {
		return err
	}
	var id string
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM space_tasks WHERE owner=? AND key=?", owner, key).Scan(&id); err != nil {
		return err
	}
	return s.advance(w, r, owner, id)
}

func (s spaceSnapshots) advance(w http.ResponseWriter, r *http.Request, owner, id string) error {
	ctx := r.Context()
	if err := s.freeze(ctx, owner, id); err != nil {
		var failure *httpx.Error
		var snapshot *snapshotFailure
		if errors.As(err, &snapshot) {
			failure = snapshot.Failure
		} else {
			errors.As(err, &failure)
		}
		if failure != nil && (failure.Status == 400 || failure.Status == 404 || failure.Status == 413) {
			stateErr := spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
				result, err := conn.ExecContext(ctx, "UPDATE space_tasks SET state='failed',lastError=? WHERE id=? AND state='pinned'", failure.Code, id)
				if err != nil {
					return err
				}
				changed, err := result.RowsAffected()
				if err == nil && changed == 1 {
					_, err = conn.ExecContext(ctx, "UPDATE space_task_inputs SET readPinned=0 WHERE taskId=?", id)
				}
				return err
			})
			if stateErr != nil {
				return stateErr
			}
		}
		return err
	}
	return s.submit(w, r, owner, id)
}

func (s spaceSnapshots) startReconciliation(ctx context.Context) func() {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for ctx.Err() == nil {
			s.reconcile(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { cancel(); <-done }
}

func (s spaceSnapshots) reconcile(ctx context.Context) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT owner,id FROM space_tasks t
		WHERE NOT EXISTS(SELECT 1 FROM space_draining_owners d WHERE d.owner=t.owner)
		  AND ((state IN ('pinned','frozen','submitted') AND lastError IS NOT 'owner_closed')
		       OR (state='failed' AND canonicalBody IS NOT NULL))`)
	if err != nil {
		return
	}
	type intent struct{ owner, id string }
	var pending []intent
	for rows.Next() {
		var row intent
		if err := rows.Scan(&row.owner, &row.id); err != nil {
			rows.Close()
			return
		}
		pending = append(pending, row)
	}
	rows.Close()
	if rows.Err() != nil {
		return
	}
	request := (&http.Request{Method: http.MethodPost}).WithContext(ctx)
	for _, row := range pending {
		if ctx.Err() != nil {
			return
		}
		_ = s.advance(nil, request, row.owner, row.id)
	}
}

func (s spaceSnapshots) submit(w http.ResponseWriter, r *http.Request, owner, id string) error {
	ctx := r.Context()
	var space, key, state string
	var body, lastError sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT spaceId,key,state,canonicalBody,lastError FROM space_tasks WHERE owner=? AND id=?`, owner, id).
		Scan(&space, &key, &state, &body, &lastError)
	if errors.Is(err, sql.ErrNoRows) {
		return httpx.NotFound
	}
	if err != nil {
		return err
	}
	if state == "abandoned" {
		code := lastError.String
		if code == "" {
			code = "owner_closed"
		}
		return httpx.NewError(409, code, "原任务提交无法继续。")
	}
	if !body.Valid {
		code := lastError.String
		if code == "" {
			code = "invalid_input"
		}
		return httpx.NewError(400, code, "所选文件无法用于任务。")
	}
	var input struct {
		Digest string `json:"inputDigest"`
	}
	if json.Unmarshal([]byte(body.String), &input) != nil || !orchestrator.ValidDigest(input.Digest) {
		return httpx.BackendUnavailable
	}
	if state == "frozen" {
		result, err := s.db.ExecContext(ctx, `
			UPDATE space_tasks SET state='submitted' WHERE id=? AND owner=? AND state='frozen'
			AND NOT EXISTS(SELECT 1 FROM space_draining_owners WHERE owner=?)`, id, owner, owner)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed == 0 {
			err := s.db.QueryRowContext(ctx, "SELECT state FROM space_tasks WHERE id=? AND owner=?", id, owner).Scan(&state)
			if errors.Is(err, sql.ErrNoRows) || state == "abandoned" || state == "frozen" {
				return httpx.NewError(409, "owner_closed", "账号已注销。")
			}
			if err != nil {
				return err
			}
		}
	}
	op := orchestrator.TaskRequest{Action: "create", Key: key, Path: "/v1/tasks", Input: json.RawMessage(body.String)}
	op.Reject = func(code string) error {
		if code != "owner_closed" && code != "idempotency_conflict" {
			return nil
		}
		return spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
			result, err := conn.ExecContext(ctx, "UPDATE space_tasks SET state='abandoned',lastError=? WHERE id=? AND owner=? AND state='submitted'", code, id, owner)
			if err != nil {
				return err
			}
			count, err := result.RowsAffected()
			if err == nil && count == 1 {
				_, err = conn.ExecContext(ctx, "UPDATE space_task_inputs SET readPinned=0 WHERE taskId=?", id)
			}
			return err
		})
	}
	op.Accept = func(value any) error {
		task := value.(map[string]any)["task"].(map[string]any)
		if task["id"] != id || task["sourceSpaceId"] != space || task["inputDigest"] != input.Digest {
			return httpx.BackendUnavailable
		}
		next := task["status"].(string)
		if next != "ready" && next != "failed" {
			return nil
		}
		return spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
			result, err := conn.ExecContext(ctx, `
				UPDATE space_tasks SET state=?,lastError=NULL
				WHERE id=? AND owner=? AND state IN ('submitted','failed')`, next, id, owner)
			if err != nil {
				return err
			}
			count, err := result.RowsAffected()
			if err == nil && count == 1 && next == "ready" {
				_, err = conn.ExecContext(ctx, "UPDATE space_task_inputs SET readPinned=0 WHERE taskId=?", id)
			}
			return err
		})
	}
	return s.backend.ForwardTask(w, r, owner, op)
}

func (s spaceSnapshots) settleProject(ctx context.Context, owner, project string) error {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM space_tasks WHERE owner=? AND spaceId=? AND state IN ('pinned','frozen','submitted') AND lastError IS NOT 'owner_closed'`, owner, project)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if rows.Err() != nil {
		return rows.Err()
	}
	request := (&http.Request{Method: http.MethodPost}).WithContext(ctx)
	for _, id := range ids {
		if err := s.advance(nil, request, owner, id); err != nil {
			return err
		}
	}
	return nil
}

func (s spaceSnapshots) drainOwner(ctx context.Context, owner string) error {
	if err := spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
		if _, err := conn.ExecContext(ctx, `UPDATE space_task_inputs SET readPinned=0
    WHERE taskId IN (SELECT id FROM space_tasks WHERE owner=? AND state IN ('pinned','frozen'))`, owner); err != nil {
			return err
		}
		_, err := conn.ExecContext(ctx, `UPDATE space_tasks SET state='abandoned',lastError='owner_closed'
    WHERE owner=? AND state IN ('pinned','frozen')`, owner)
		return err
	}); err != nil {
		return err
	}
	type intent struct{ id, key, space, body string }
	rows, err := s.db.QueryContext(ctx, `SELECT id,key,spaceId,canonicalBody FROM space_tasks
   WHERE owner=? AND state='submitted' AND lastError IS NOT 'owner_closed'`, owner)
	if err != nil {
		return err
	}
	var pending []intent
	for rows.Next() {
		var row intent
		if err := rows.Scan(&row.id, &row.key, &row.space, &row.body); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, row)
	}
	rows.Close()
	if rows.Err() != nil {
		return rows.Err()
	}
	request := (&http.Request{Method: http.MethodGet}).WithContext(ctx)
	for _, row := range pending {
		var input struct {
			Digest string `json:"inputDigest"`
		}
		if json.Unmarshal([]byte(row.body), &input) != nil || !orchestrator.ValidDigest(input.Digest) {
			return httpx.BackendUnavailable
		}
		var accepted bool
		op := orchestrator.TaskRequest{Action: "list", Path: "/v1/tasks", Query: url.Values{"creationKey": {row.key}}}
		op.Accept = func(value any) error {
			items := value.(map[string]any)["items"].([]any)
			if len(items) > 1 {
				return httpx.BackendUnavailable
			}
			state, last := "abandoned", any("owner_closed")
			if len(items) == 1 {
				receipt := items[0].(map[string]any)
				if receipt["id"] != row.id || receipt["sourceSpaceId"] != row.space || receipt["inputDigest"] != input.Digest {
					return httpx.BackendUnavailable
				}
				state = receipt["status"].(string)
				if state == "ready" || state == "failed" {
					last = nil
				} else {
					state = "submitted"
				}
			}
			err := spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
				changed, err := conn.ExecContext(ctx, `UPDATE space_tasks SET state=?,lastError=? WHERE owner=? AND id=? AND state='submitted'`, state, last, owner, row.id)
				if err != nil {
					return err
				}
				count, err := changed.RowsAffected()
				if err == nil && count == 1 && (state == "abandoned" || state == "ready") {
					_, err = conn.ExecContext(ctx, "UPDATE space_task_inputs SET readPinned=0 WHERE taskId=?", row.id)
				}
				return err
			})
			accepted = err == nil
			return err
		}
		if err := s.backend.ForwardTask(nil, request, owner, op); err != nil {
			return err
		}
		if !accepted {
			return httpx.BackendUnavailable
		}
	}
	return nil
}
