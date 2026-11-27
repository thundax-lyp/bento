package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/httpx"
	"io"
	"mime"
	"net/http"
	"net/url"

	"github.com/google/uuid"
)

type spaceFileDeletion struct {
	db      *sql.DB
	storage uploadStorage
	hold    func(context.Context, spaceUpload, fileDeletionIntent, bool) (string, error)
}

type fileDeletionIntent struct {
	operation, phase string
	project          sql.NullString
}

var (
	fileDeleteUnconfirmed = httpx.NewError(503, "file_delete_unconfirmed", "暂未确认删除结果，请刷新后重试。")
	fileDeleteBusy        = httpx.NewError(409, "project_busy", "文件正在被未结束的任务使用。")
)

func spaceImmediate(ctx context.Context, db *sql.DB, run func(*sql.Conn) error) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer func() { _, _ = conn.ExecContext(context.WithoutCancel(ctx), "ROLLBACK") }()
	if err := run(conn); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

func readFileDeletion(ctx context.Context, query spaceUploadQuery, file string) (fileDeletionIntent, error) {
	var intent fileDeletionIntent
	err := query.QueryRowContext(ctx, `
		SELECT operationId,executionProjectId,phase FROM space_file_deletions WHERE fileId=?`, file).
		Scan(&intent.operation, &intent.project, &intent.phase)
	return intent, err
}

func (s spaceFileDeletion) enroll(ctx context.Context, owner, id string) (spaceUpload, fileDeletionIntent, int, error) {
	var row spaceUpload
	var intent fileDeletionIntent
	status := http.StatusAccepted
	err := spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
		var err error
		row, err = loadSpaceUpload(ctx, conn, id)
		if errors.Is(err, sql.ErrNoRows) || err == nil && row.owner != owner {
			return httpx.NotFound
		}
		if err != nil {
			return err
		}
		var blocked bool
		err = conn.QueryRowContext(ctx, `
			SELECT EXISTS(SELECT 1 FROM space_project_deletions WHERE owner=? AND spaceId=?)
			    OR EXISTS(SELECT 1 FROM space_draining_owners WHERE owner=?)`, owner, row.Project, owner).Scan(&blocked)
		if err != nil {
			return err
		}
		if blocked {
			return httpx.NewError(409, "project_busy", "项目仍有未结束的任务或正在清理。")
		}
		switch row.State {
		case "deleted":
			status = http.StatusNoContent
			return nil
		case "deleting":
			return nil
		case "saved":
		default:
			return httpx.NotFound
		}
		intent, err = readFileDeletion(ctx, conn, id)
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var pinned bool
		if err := conn.QueryRowContext(ctx,
			"SELECT EXISTS(SELECT 1 FROM space_task_inputs WHERE fileId=? AND readPinned=1)", id).Scan(&pinned); err != nil {
			return err
		}
		if pinned {
			return fileDeleteBusy
		}
		var execOwner, state, inputs string
		var project sql.NullString
		err = conn.QueryRowContext(ctx, `
			SELECT owner,state,inputs,projectId FROM space_execution WHERE spaceId=? ORDER BY rowid DESC LIMIT 1`, row.Project).
			Scan(&execOwner, &state, &inputs, &project)
		if err == nil {
			if execOwner != owner {
				return httpx.NotFound
			}
			var manifest []struct {
				FileID string `json:"fileId"`
			}
			if err := json.Unmarshal([]byte(inputs), &manifest); err != nil {
				return err
			}
			for _, input := range manifest {
				if input.FileID != id {
					continue
				}
				if state == "validating" || state == "importing" {
					return httpx.NewError(409, "project_importing", "文件正在用于初始化工作区。")
				}
				intent.project = project
				break
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		op, err := uuid.NewRandom()
		if err != nil {
			return err
		}
		intent.operation, intent.phase = op.String(), "checking"
		_, err = conn.ExecContext(ctx,
			"INSERT INTO space_file_deletions (fileId,operationId,executionProjectId,phase) VALUES (?,?,?,'checking')",
			id, intent.operation, intent.project)
		return err
	})
	return row, intent, status, err
}

func (s spaceFileDeletion) check(ctx context.Context, row spaceUpload, intent fileDeletionIntent) (bool, error) {
	if intent.phase != "checking" {
		return false, fileDeleteUnconfirmed
	}
	state, err := s.hold(ctx, row, intent, false)
	var failure *httpx.Error
	rejected := errors.As(err, &failure) && (failure.Code == "owner_closed" || failure.Code == "not_found")
	if rejected || err == nil && state == "denied" {
		_, removeErr := s.db.ExecContext(ctx, `
			DELETE FROM space_file_deletions WHERE fileId=? AND operationId=? AND phase='checking'`, row.ID, intent.operation)
		if removeErr != nil {
			return false, removeErr
		}
		return false, err
	}
	if err != nil || state != "held" {
		return false, fileDeleteUnconfirmed
	}
	err = spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
		result, err := conn.ExecContext(ctx, "UPDATE space_uploads SET state='deleting' WHERE id=? AND owner=? AND state='saved'", row.ID, row.owner)
		if err := requireOneSpaceUpdate(result, err); err != nil {
			return err
		}
		result, err = conn.ExecContext(ctx, `
			UPDATE space_file_deletions SET phase='deleting' WHERE fileId=? AND operationId=? AND phase='checking'`, row.ID, intent.operation)
		return requireOneSpaceUpdate(result, err)
	})
	return err == nil, err
}

func requireOneSpaceUpdate(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	if changed, err := result.RowsAffected(); err != nil || changed != 1 {
		if err != nil {
			return err
		}
		return fileDeleteUnconfirmed
	}
	return nil
}

func (s spaceFileDeletion) request(ctx context.Context, owner, id string) (int, error) {
	row, intent, status, err := s.enroll(ctx, owner, id)
	if err != nil || intent.operation == "" {
		return status, err
	}
	held, err := s.check(ctx, row, intent)
	var failure *httpx.Error
	if err != nil {
		if errors.As(err, &failure) && (failure.Code == "owner_closed" || failure.Code == "not_found") {
			return 0, err
		}
		return 0, fileDeleteUnconfirmed
	}
	if !held {
		return 0, fileDeleteBusy
	}
	return http.StatusAccepted, nil
}

func (s spaceFileDeletion) advance(ctx context.Context, row spaceUpload) error {
	intent, err := readFileDeletion(ctx, s.db, row.ID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if intent.phase == "checking" {
		held, err := s.check(ctx, row, intent)
		if err != nil || !held {
			return err
		}
		intent.phase = "deleting"
	}
	if intent.phase == "deleting" {
		key := spaceObjectKey(row.ID)
		if _, exists, err := s.storage.size(ctx, key); err != nil {
			return err
		} else if exists {
			if err := s.storage.remove(ctx, key); err != nil {
				return err
			}
		}
		result, err := s.db.ExecContext(ctx, `
			UPDATE space_file_deletions SET phase='releasing' WHERE fileId=? AND operationId=? AND phase='deleting'`,
			row.ID, intent.operation)
		if err := requireOneSpaceUpdate(result, err); err != nil {
			return err
		}
	}
	state, err := s.hold(ctx, row, intent, true)
	if err != nil || state != "released" {
		return fileDeleteUnconfirmed
	}
	return spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
		result, err := conn.ExecContext(ctx, "UPDATE space_uploads SET state='deleted' WHERE id=? AND owner=? AND state='deleting'", row.ID, row.owner)
		if err := requireOneSpaceUpdate(result, err); err != nil {
			return err
		}
		result, err = conn.ExecContext(ctx, `
			DELETE FROM space_file_deletions WHERE fileId=? AND operationId=? AND phase='releasing'`, row.ID, intent.operation)
		return requireOneSpaceUpdate(result, err)
	})
}

func (s projectService) fileHold(ctx context.Context, row spaceUpload, intent fileDeletionIntent, release bool) (string, error) {
	method := http.MethodPost
	if release {
		method = http.MethodDelete
	}
	path := "/v1/task-sources/" + url.PathEscape(row.Project) + "/files/" + url.PathEscape(row.ID) +
		"/deletion-holds/" + url.PathEscape(intent.operation)
	if intent.project.Valid {
		path += "?" + url.Values{"legacyProjectId": {intent.project.String}}.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, method, s.origin+path, nil)
	if err != nil {
		return "", fileDeleteUnconfirmed
	}
	request.Header.Set("Authorization", "Bearer "+s.bearer)
	request.Header.Set("X-Bento-Owner-Id", row.owner)
	response, err := s.client.Do(request)
	if err != nil {
		return "", fileDeleteUnconfirmed
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return "", httpx.NotFound
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if media != "application/json" {
		return "", fileDeleteUnconfirmed
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil || len(raw) > 64*1024 {
		return "", fileDeleteUnconfirmed
	}
	if response.StatusCode == http.StatusConflict {
		var result struct {
			Error struct{ Code string } `json:"error"`
		}
		if json.Unmarshal(raw, &result) == nil && result.Error.Code == "owner_closed" {
			return "", httpx.NewError(409, "owner_closed", "当前请求无法执行。")
		}
	}
	var result struct {
		State string `json:"state"`
	}
	if response.StatusCode != http.StatusOK || json.Unmarshal(raw, &result) != nil {
		return "", fileDeleteUnconfirmed
	}
	switch result.State {
	case "held", "denied", "released":
		return result.State, nil
	default:
		return "", fileDeleteUnconfirmed
	}
}
