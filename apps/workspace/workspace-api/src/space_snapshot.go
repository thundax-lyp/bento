package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

type spaceSnapshots struct {
	db   *sql.DB
	read func(context.Context, string, int64) ([]byte, error)
}

type snapshotIssue struct {
	FileID string `json:"fileId"`
	Path   string `json:"path"`
	Code   string `json:"code"`
}

type snapshotFailure struct {
	requestFailure
	Issues []snapshotIssue
}

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
func snapshotJSON(files []projectFile) []byte {
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
		return notFound
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
		return &requestFailure{413, "too_large", "任务快照最多 100 个文件。"}
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
			return notFound
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
		return &snapshotFailure{requestFailure{413, "too_large", "任务快照的文本总量不能超过 1 MiB。"}, oversized}
	}
	files := make([]projectFile, 0, len(ids))
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
		files = append(files, projectFile{Path: row.Path, Text: string(data)})
		manifest = append(manifest, snapshotManifestEntry{row.ID, row.Path, row.Size, hex.EncodeToString(digest[:])})
	}
	if len(issues) != 0 {
		return &snapshotFailure{requestFailure{400, "invalid_input", "请调整所选文件后重试。"}, issues}
	}

	for _, file := range files {
		for _, other := range files {
			if strings.HasPrefix(other.Path, file.Path+"/") {
				return &requestFailure{400, "path_conflict", "文件路径和目录路径冲突。"}
			}
		}
	}
	slices.SortFunc(files, func(a, b projectFile) int {
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
