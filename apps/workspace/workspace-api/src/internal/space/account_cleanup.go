package space

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
)

func (s *Service) PurgeOwner(ctx context.Context, owner string) bool {
	uploads := spaceUploads{db: s.db, storage: s.storage, now: time.Now}
	rows, err := uploads.db.QueryContext(ctx, "SELECT id FROM space_uploads WHERE owner=?", owner)
	if err != nil {
		return false
	}
	var files []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return false
		}
		files = append(files, id)
	}
	rows.Close()
	if rows.Err() != nil {
		return false
	}
	for _, id := range files {
		if !s.purgeFile(ctx, uploads, owner, id) {
			return false
		}
	}
	complete, err := uploads.purgeAccountMetadata(ctx, owner)
	return err == nil && complete
}

func (s *Service) DrainOwner(ctx context.Context, owner string) bool {
	lock, token := "execution:"+owner, uuid.NewString()
	if !s.locks.acquire(lock, token) {
		return false
	}
	defer s.locks.release(lock, token)
	if err := s.snapshots.drainOwner(ctx, owner); err != nil {
		return false
	}
	var pending bool
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS(SELECT 1 FROM space_project_deletions WHERE owner=? AND phase<>'deleted')
			OR EXISTS(SELECT 1 FROM space_file_deletions d JOIN space_uploads u ON u.id=d.fileId WHERE u.owner=?)
			OR EXISTS(SELECT 1 FROM space_tasks WHERE owner=? AND state IN ('pinned','frozen','submitted') AND lastError IS NOT 'owner_closed')`,
		owner, owner, owner).Scan(&pending)
	return err == nil && !pending
}

func (s *Service) purgeFile(ctx context.Context, uploads spaceUploads, owner, id string) bool {
	token, err := uuid.NewRandom()
	if err != nil || !s.locks.acquire(id, token.String()) {
		return false
	}
	defer s.locks.release(id, token.String())
	row, err := loadSpaceUpload(ctx, uploads.db, id)
	if errors.Is(err, sql.ErrNoRows) {
		return true
	}
	if err != nil || row.owner != owner {
		return false
	}
	complete, err := uploads.purgeAccountObject(ctx, row)
	return err == nil && complete
}
