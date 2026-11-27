package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"

	"github.com/google/uuid"
)

var projectDeleteUnconfirmed = &requestFailure{503, "project_delete_unconfirmed", "暂无法确认项目删除进度，请重试。"}

type spaceProjectDeletion struct {
	db      *sql.DB
	storage uploadStorage
	backend projectService
}

type projectDeleteIntent struct {
	operation, phase string
	execution, last  sql.NullString
}

func projectDeletionBlocked(code string) error {
	messages := map[string]string{
		"upload_pending":    "请先取消并清理未完成的上传。",
		"project_importing": "请等待工作区初始化结束。",
		"project_busy":      "项目仍有未结束的任务或正在清理。",
	}
	return &requestFailure{409, code, messages[code]}
}

func (s spaceProjectDeletion) enroll(ctx context.Context, owner, id string) error {
	return spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
		var prior bool
		err := conn.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM space_project_deletions WHERE owner=? AND spaceId=?)", owner, id).Scan(&prior)
		if err != nil || prior {
			return err
		}
		var project, drained, upload, fileDelete bool
		err = conn.QueryRowContext(ctx, `
			SELECT EXISTS(SELECT 1 FROM space_projects WHERE owner=? AND id=?),
			       EXISTS(SELECT 1 FROM space_draining_owners WHERE owner=?),
			       EXISTS(SELECT 1 FROM space_uploads WHERE owner=? AND project=? AND state IN ('preparing','uploading','completing','cleaning')),
			       EXISTS(SELECT 1 FROM space_file_deletions d JOIN space_uploads u ON u.id=d.fileId WHERE u.owner=? AND u.project=?)`,
			owner, id, owner, owner, id, owner, id).Scan(&project, &drained, &upload, &fileDelete)
		if err != nil {
			return err
		}
		if !project {
			return notFound
		}
		var execution sql.NullString
		var execOwner, state string
		err = conn.QueryRowContext(ctx, "SELECT owner,state,projectId FROM space_execution WHERE spaceId=? ORDER BY rowid DESC LIMIT 1", id).
			Scan(&execOwner, &state, &execution)
		if err == nil && execOwner != owner {
			return notFound
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		switch {
		case drained:
			return projectDeletionBlocked("project_busy")
		case upload:
			return projectDeletionBlocked("upload_pending")
		case state == "validating" || state == "importing":
			return projectDeletionBlocked("project_importing")
		case fileDelete:
			return projectDeleteUnconfirmed
		}
		op, err := uuid.NewRandom()
		if err != nil {
			return err
		}
		_, err = conn.ExecContext(ctx, `
			INSERT INTO space_project_deletions (spaceId,owner,operationId,executionProjectId,phase)
			VALUES (?,?,?,?,'holding')`, id, owner, op.String(), execution)
		return err
	})
}

func (s spaceProjectDeletion) forward(ctx context.Context, owner, id string, intent projectDeleteIntent, phase string) (int, string, error) {
	query := url.Values{"phase": {phase}}
	if intent.execution.Valid {
		query.Set("legacyProjectId", intent.execution.String)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		s.backend.origin+"/v1/task-sources/"+url.PathEscape(id)+"?"+query.Encode(), nil)
	if err != nil {
		return 0, "", err
	}
	request.Header.Set("Authorization", "Bearer "+s.backend.bearer)
	request.Header.Set("X-Bento-Owner-Id", owner)
	request.Header.Set("Idempotency-Key", intent.operation)
	response, err := s.backend.client.Do(request)
	if err != nil {
		return 0, "", err
	}
	defer response.Body.Close()
	if response.StatusCode == 204 {
		return 204, "", nil
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if media != "application/json" {
		return 0, "", projectDeleteUnconfirmed
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	var reply struct {
		State string                `json:"state"`
		Error struct{ Code string } `json:"error"`
	}
	if err != nil || len(raw) > 64*1024 || json.Unmarshal(raw, &reply) != nil {
		return 0, "", projectDeleteUnconfirmed
	}
	if response.StatusCode == 409 {
		return 409, reply.Error.Code, nil
	}
	if response.StatusCode == 202 {
		return 202, reply.State, nil
	}
	return 0, "", projectDeleteUnconfirmed
}

func (s spaceProjectDeletion) advance(ctx context.Context, owner, id string) (int, error) {
	var intent projectDeleteIntent
	err := s.db.QueryRowContext(ctx, `
		SELECT operationId,phase,executionProjectId,lastError FROM space_project_deletions WHERE owner=? AND spaceId=?`, owner, id).
		Scan(&intent.operation, &intent.phase, &intent.execution, &intent.last)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, notFound
	}
	if err != nil {
		return 0, err
	}
	record := func(phase string, last any) error {
		_, err := s.db.ExecContext(ctx, "UPDATE space_project_deletions SET phase=?,lastError=? WHERE owner=? AND spaceId=? AND operationId=?",
			phase, last, owner, id, intent.operation)
		return err
	}
	beginCleaning := func() error {
		return spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
			if _, err := conn.ExecContext(ctx, "UPDATE space_project_deletions SET phase='cleaning',lastError=NULL WHERE owner=? AND spaceId=?", owner, id); err != nil {
				return err
			}
			_, err := conn.ExecContext(ctx, "UPDATE space_uploads SET state='deleting' WHERE owner=? AND project=? AND state='saved'", owner, id)
			return err
		})
	}
	if intent.phase == "deleted" {
		return 204, nil
	}
	if intent.phase == "holding" {
		status, value, err := s.forward(ctx, owner, id, intent, "hold")
		switch {
		case err == nil && status == 204:
			if err := beginCleaning(); err != nil {
				return 0, err
			}
			intent.phase = "cleaning"
		case err == nil && status == 202 && (value == "deleting" || value == "held"):
			if err := record("committing", nil); err != nil {
				return 0, err
			}
			if value == "deleting" {
				return 202, nil
			}
			intent.phase = "committing"
		case err == nil && status == 409 && (value == "project_busy" || value == "project_importing" || value == "owner_closed"):
			if err := record("releasing", value); err != nil {
				return 0, err
			}
			intent.phase = "releasing"
			intent.last = sql.NullString{String: value, Valid: true}
		default:
			_ = record("holding", "execution_unconfirmed")
			return 0, projectDeleteUnconfirmed
		}
	}
	if intent.phase == "releasing" {
		status, value, err := s.forward(ctx, owner, id, intent, "release")
		if err == nil && status == 409 && value == "deletion_committed" {
			return 202, record("committing", nil)
		}
		if err != nil || status != 204 {
			return 0, projectDeleteUnconfirmed
		}
		if _, err := s.db.ExecContext(ctx, "DELETE FROM space_project_deletions WHERE owner=? AND spaceId=? AND operationId=?", owner, id, intent.operation); err != nil {
			return 0, err
		}
		if intent.last.String == "project_importing" {
			return 0, projectDeletionBlocked("project_importing")
		}
		return 0, projectDeletionBlocked("project_busy")
	}
	if intent.phase == "committing" {
		status, value, err := s.forward(ctx, owner, id, intent, "commit")
		if err == nil && status == 202 && value == "deleting" {
			return 202, nil
		}
		if err != nil || status != 204 {
			_ = record("committing", "execution_unconfirmed")
			return 0, projectDeleteUnconfirmed
		}
		if err := beginCleaning(); err != nil {
			return 0, err
		}
	}
	if err := s.clean(ctx, owner, id); err != nil {
		_ = record("cleaning", "storage_unconfirmed")
		return 202, nil
	}
	return 204, nil
}

func (s spaceProjectDeletion) clean(ctx context.Context, owner, id string) error {
	rows, err := s.db.QueryContext(ctx, "SELECT id FROM space_uploads WHERE owner=? AND project=? AND state='deleting' ORDER BY rowid", owner, id)
	if err != nil {
		return err
	}
	var files []string
	for rows.Next() {
		var file string
		if err := rows.Scan(&file); err != nil {
			rows.Close()
			return err
		}
		files = append(files, file)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, file := range files {
		key := spaceObjectKey(file)
		if _, found, err := s.storage.size(ctx, key); err != nil {
			return err
		} else if found {
			if err := s.storage.remove(ctx, key); err != nil {
				return err
			}
		}
		if _, found, err := s.storage.size(ctx, key); err != nil || found {
			return projectDeleteUnconfirmed
		}
		if _, err := s.db.ExecContext(ctx, "UPDATE space_uploads SET state='deleted' WHERE id=? AND owner=? AND project=?", file, owner, id); err != nil {
			return err
		}
	}
	return spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
		for _, query := range []string{
			"INSERT OR IGNORE INTO space_retired_upload_ids SELECT id FROM space_uploads WHERE owner=? AND project=?",
			"DELETE FROM space_uploads WHERE owner=? AND project=?",
			"DELETE FROM space_execution WHERE owner=? AND spaceId=?",
			"DELETE FROM space_task_inputs WHERE taskId IN (SELECT id FROM space_tasks WHERE owner=? AND spaceId=?)",
			"DELETE FROM space_tasks WHERE owner=? AND spaceId=?",
			"DELETE FROM space_projects WHERE owner=? AND id=?",
			"UPDATE space_project_deletions SET phase='deleted',lastError=NULL WHERE owner=? AND spaceId=?",
		} {
			if _, err := conn.ExecContext(ctx, query, owner, id); err != nil {
				return err
			}
		}
		return nil
	})
}
