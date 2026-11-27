package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
)

type accountSweep struct {
	store   accounts
	backend projectService
	space   *spaceReader
}

func (s accountSweep) start(ctx context.Context) func() {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for ctx.Err() == nil {
			s.run(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { cancel(); <-done }
}

func (s accountSweep) run(ctx context.Context) {
	pending, err := s.store.pendingPurges(ctx)
	if err != nil {
		return
	}
	for _, row := range pending {
		if ctx.Err() != nil {
			return
		}
		if s.purge(ctx, row) {
			_ = s.store.finishPurge(ctx, row.Owner)
		}
	}
}

func (s accountSweep) purge(ctx context.Context, row purge) bool {
	if s.space != nil {
		if _, err := s.space.db.ExecContext(ctx, "INSERT OR IGNORE INTO space_draining_owners VALUES (?)", row.Owner); err != nil {
			return false
		}
	}
	if _, err := s.accountRequest(ctx, row.Owner, "/v1/account/drain", nil); err != nil {
		return false
	}
	if s.space != nil && !s.drainSpace(ctx, row.Owner) {
		return false
	}
	complete, err := s.accountRequest(ctx, row.Owner, "/v1/account/purge", []byte("{}"))
	if err != nil || !complete {
		return false
	}
	if s.space == nil {
		return !row.Space
	}
	uploads := spaceUploads{db: s.space.db, storage: s.space.storage, now: time.Now}
	rows, err := uploads.db.QueryContext(ctx, "SELECT id FROM space_uploads WHERE owner=?", row.Owner)
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
		if !s.purgeFile(ctx, uploads, row.Owner, id) {
			return false
		}
	}
	complete, err = uploads.purgeAccountMetadata(ctx, row.Owner)
	return err == nil && complete
}

func (s accountSweep) drainSpace(ctx context.Context, owner string) bool {
	lock, token := "execution:"+owner, uuid.NewString()
	if !s.space.locks.acquire(lock, token) {
		return false
	}
	defer s.space.locks.release(lock, token)
	snapshots := spaceSnapshots{db: s.space.db, backend: s.backend}
	if err := snapshots.drainOwner(ctx, owner); err != nil {
		return false
	}
	var pending bool
	err := s.space.db.QueryRowContext(ctx, `
		SELECT EXISTS(SELECT 1 FROM space_project_deletions WHERE owner=? AND phase<>'deleted')
			OR EXISTS(SELECT 1 FROM space_file_deletions d JOIN space_uploads u ON u.id=d.fileId WHERE u.owner=?)
			OR EXISTS(SELECT 1 FROM space_tasks WHERE owner=? AND state IN ('pinned','frozen','submitted') AND lastError IS NOT 'owner_closed')`,
		owner, owner, owner).Scan(&pending)
	return err == nil && !pending
}

func (s accountSweep) accountRequest(ctx context.Context, owner, path string, raw []byte) (bool, error) {
	var body io.Reader
	if raw != nil {
		body = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.backend.origin+path, body)
	if err != nil {
		return false, err
	}
	request.Header.Set("Authorization", "Bearer "+s.backend.bearer)
	request.Header.Set("X-Bento-Owner-Id", owner)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := s.backend.client.Do(request)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if raw == nil && response.StatusCode == http.StatusNoContent {
		return true, nil
	}
	if raw == nil || response.StatusCode != http.StatusOK && response.StatusCode != http.StatusAccepted {
		return false, backendUnavailable
	}
	var result struct {
		Complete *bool `json:"complete"`
	}
	encoded, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(encoded) > 65536 || json.Unmarshal(encoded, &result) != nil || result.Complete == nil {
		return false, backendUnavailable
	}
	return *result.Complete, nil
}

func (s accountSweep) purgeFile(ctx context.Context, uploads spaceUploads, owner, id string) bool {
	token, err := uuid.NewRandom()
	if err != nil || !s.space.locks.acquire(id, token.String()) {
		return false
	}
	defer s.space.locks.release(id, token.String())
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
