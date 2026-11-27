package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
)

func (s spaceUploads) ownerUpload(ctx context.Context, owner, id string, writable bool) (spaceUpload, error) {
	row, err := loadSpaceUpload(ctx, s.db, id)
	if errors.Is(err, sql.ErrNoRows) || err == nil && row.owner != owner {
		return row, notFound
	}
	if err != nil {
		return row, err
	}
	var deleted, draining bool
	err = s.db.QueryRowContext(ctx, `
		SELECT EXISTS(SELECT 1 FROM space_project_deletions WHERE owner=? AND spaceId=?),
		       EXISTS(SELECT 1 FROM space_draining_owners WHERE owner=?)`, owner, row.Project, owner).
		Scan(&deleted, &draining)
	if err != nil {
		return row, err
	}
	if writable && (deleted || draining) {
		return row, projectDeletionBlocked("project_busy")
	}
	if deleted {
		return row, notFound
	}
	return row, nil
}

func (s spaceUploads) routes(mux *http.ServeMux, sessions *webSessions, backend projectService, origin string, locks *spaceLocks) {
	deletions := spaceFileDeletion{db: s.db, storage: s.storage, hold: backend.fileHold}
	register := func(pattern string, handle func(http.ResponseWriter, *http.Request, string) error) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			backend.responseHeaders(w)
			if r.Method != http.MethodGet && r.Method != http.MethodHead &&
				(len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != origin) {
				authFailure(w, &requestFailure{400, "invalid_origin", "请从任务入口提交请求。"})
				return
			}
			session, err := sessions.current(r)
			if err == nil && r.Method == http.MethodHead {
				err = notFound
			}
			if err == nil {
				err = handle(w, r, session.Owner)
			}
			if err != nil {
				authFailure(w, err)
			}
		})
	}
	locked := func(id string, busy error, run func() error) error {
		token, err := uuid.NewRandom()
		if err != nil {
			return err
		}
		if !locks.acquire(id, token.String()) {
			return busy
		}
		defer locks.release(id, token.String())
		return run()
	}
	busy := spaceConflict("操作处理中，请稍后查看状态。")
	register("POST /api/space/projects/{project}/uploads", func(w http.ResponseWriter, r *http.Request, owner string) error {
		project := r.PathValue("project")
		if !taskUUID.MatchString(project) {
			return notFound
		}
		fields, err := readProjectJSON(w, r, 32*1024)
		if err != nil {
			return err
		}
		input, err := parseUploadReservation(fields)
		if err != nil {
			return err
		}
		if _, err := s.reserve(r.Context(), owner, project, input); err != nil {
			return err
		}
		return locked(input.id, busy, func() error {
			row, err := s.ownerUpload(r.Context(), owner, input.id, true)
			if err != nil {
				return err
			}
			if err := s.prepare(r.Context(), &row); err != nil {
				return err
			}
			authJSON(w, 200, row.spaceUploadView)
			return nil
		})
	})
	register("GET /api/space/uploads/{id}", func(w http.ResponseWriter, r *http.Request, owner string) error {
		id := r.PathValue("id")
		if !taskUUID.MatchString(id) {
			return notFound
		}
		row, err := s.ownerUpload(r.Context(), owner, id, false)
		if err != nil {
			return err
		}
		parts := []int32{}
		if row.State == "uploading" {
			upstream, _, err := s.completedParts(r.Context(), row)
			if err != nil {
				return err
			}
			for _, part := range upstream {
				parts = append(parts, *part.PartNumber)
			}
		}
		authJSON(w, 200, struct {
			spaceUploadView
			Parts []int32 `json:"parts"`
		}{row.spaceUploadView, parts})
		return nil
	})
	for _, action := range []string{"part", "complete", "cancel"} {
		register("POST /api/space/uploads/{id}/"+action, func(w http.ResponseWriter, r *http.Request, owner string) error {
			id := r.PathValue("id")
			if !taskUUID.MatchString(id) {
				return notFound
			}
			return locked(id, busy, func() error {
				row, err := s.ownerUpload(r.Context(), owner, id, true)
				if err != nil {
					return err
				}
				switch action {
				case "complete":
					err = s.finish(r.Context(), &row)
				case "cancel":
					switch row.State {
					case "saved", "completing":
						return spaceConflict("文件已保存或正在确认结果。")
					case "preparing", "uploading", "cleaning":
						err = s.clean(r.Context(), &row, "cancelled")
					}
				case "part":
					if err := s.prepare(r.Context(), &row); err != nil {
						return err
					}
					if row.State != "uploading" || !row.storageID.Valid || row.Expires <= s.now().UnixMilli() {
						return spaceConflict("上传不可继续。")
					}
					fields, err := readProjectJSON(w, r, 32*1024)
					if err != nil {
						return err
					}
					number, err := taskInteger(1)(fields["number"])
					if err != nil || number.(int64) > 100 {
						return invalidSpace("分块编号无效。")
					}
					signed, checksum, err := s.signPart(r.Context(), &row, int32(number.(int64)))
					if err == nil {
						authJSON(w, 200, map[string]string{"url": signed, "checksum": checksum})
					}
					return err
				}
				if err == nil {
					authJSON(w, 200, row.spaceUploadView)
				}
				return err
			})
		})
	}
	register("DELETE /api/space/files/{id}", func(w http.ResponseWriter, r *http.Request, owner string) error {
		id := r.PathValue("id")
		if !taskUUID.MatchString(id) {
			return notFound
		}
		row, err := s.ownerUpload(r.Context(), owner, id, true)
		if err != nil {
			return err
		}
		switch row.State {
		case "deleted":
			w.WriteHeader(http.StatusNoContent)
			return nil
		case "deleting":
			authJSON(w, http.StatusAccepted, map[string]string{"state": "deleting"})
			return nil
		case "saved":
		default:
			return notFound
		}
		return locked(id, fileDeleteUnconfirmed, func() error {
			status, err := deletions.request(r.Context(), owner, id)
			if err == nil {
				if status == http.StatusNoContent {
					w.WriteHeader(status)
				} else {
					authJSON(w, status, map[string]string{"state": "deleting"})
				}
			}
			return err
		})
	})
}

func (s spaceUploads) startReconciliation(ctx context.Context, locks *spaceLocks, backend projectService, reconcileProjects func(context.Context)) func() {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.reconcile(ctx, locks, backend)
				reconcileProjects(ctx)
			}
		}
	}()
	return func() { cancel(); <-done }
}

func (s spaceUploads) reconcile(ctx context.Context, locks *spaceLocks, backend projectService) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id FROM space_uploads WHERE state='completing'
		   OR (state='cleaning' AND signedUntil<=?)
		   OR (state IN ('preparing','uploading') AND expires<=?)
		   OR EXISTS(SELECT 1 FROM space_file_deletions WHERE fileId=space_uploads.id)`,
		s.now().UnixMilli(), s.now().UnixMilli())
	if err != nil {
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return
		}
		ids = append(ids, id)
	}
	rows.Close()
	if rows.Err() != nil {
		return
	}
	deletions := spaceFileDeletion{db: s.db, storage: s.storage, hold: backend.fileHold}
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		func() {
			token, err := uuid.NewRandom()
			if err != nil || !locks.acquire(id, token.String()) {
				return
			}
			defer locks.release(id, token.String())
			row, err := loadSpaceUpload(ctx, s.db, id)
			if err != nil {
				return
			}
			switch {
			case row.State == "completing":
				_ = s.finish(ctx, &row)
			case row.State == "cleaning" || (row.State == "preparing" || row.State == "uploading") && row.Expires <= s.now().UnixMilli():
				_ = s.clean(ctx, &row, "expired")
			default:
				_ = deletions.advance(ctx, row)
			}
		}()
	}
}
