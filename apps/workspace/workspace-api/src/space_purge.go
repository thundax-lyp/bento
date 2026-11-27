package main

import (
	"context"
	"database/sql"
	"errors"
)

// The caller holds the same per-file lock as multipart and deletion operations.
func (s spaceUploads) purgeAccountObject(ctx context.Context, row spaceUpload) (bool, error) {
	if row.State != "saved" && row.signedUntil > s.now().UnixMilli() {
		return false, nil
	}
	key := spaceObjectKey(row.ID)
	if row.Size > 0 {
		if err := s.storage.abort(ctx, key, row.storageID.String); err != nil {
			return false, err
		}
	}
	if _, found, err := s.storage.size(ctx, key); err != nil {
		return false, err
	} else if found {
		if err := s.storage.remove(ctx, key); err != nil {
			return false, err
		}
	}
	if _, found, err := s.storage.size(ctx, key); err != nil {
		return false, err
	} else if found {
		return false, errors.New("object cleanup pending")
	}
	err := spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
		if _, err := conn.ExecContext(ctx, "INSERT OR IGNORE INTO space_retired_upload_ids VALUES (?)", row.ID); err != nil {
			return err
		}
		result, err := conn.ExecContext(ctx, "DELETE FROM space_uploads WHERE id=? AND owner=?", row.ID, row.owner)
		return requireOneSpaceUpdate(result, err)
	})
	return err == nil, err
}

// Keep the owner fence and retired upload IDs after removing account-owned metadata.
func (s spaceUploads) purgeAccountMetadata(ctx context.Context, owner string) (bool, error) {
	var complete bool
	err := spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
		var drained, populated bool
		err := conn.QueryRowContext(ctx, `
			SELECT EXISTS(SELECT 1 FROM space_draining_owners WHERE owner=?),
			       EXISTS(SELECT 1 FROM space_uploads WHERE owner=?)`, owner, owner).Scan(&drained, &populated)
		if err != nil || !drained || populated {
			return err
		}
		for _, query := range []string{
			"DELETE FROM space_task_inputs WHERE taskId IN (SELECT id FROM space_tasks WHERE owner=?)",
			"DELETE FROM space_tasks WHERE owner=?",
			"DELETE FROM space_execution WHERE owner=?",
			"DELETE FROM space_projects WHERE owner=?",
			"DELETE FROM space_project_deletions WHERE owner=?",
		} {
			if _, err := conn.ExecContext(ctx, query, owner); err != nil {
				return err
			}
		}
		complete = true
		return nil
	})
	return complete && err == nil, err
}
