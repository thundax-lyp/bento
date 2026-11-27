package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"path"
	"path/filepath"

	_ "modernc.org/sqlite"
)

type spaceReader struct {
	db      *sql.DB
	storage *spaceStorage
}

type spaceProjectView struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	State string `json:"state,omitempty"`
}

type spaceUploadView struct {
	ID      string `json:"id"`
	Project string `json:"project"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	State   string `json:"state"`
	Expires int64  `json:"expires"`
}

type spaceOverview struct {
	Projects  []spaceProjectView `json:"projects"`
	Uploads   []spaceUploadView  `json:"uploads"`
	Quota     int64              `json:"quota"`
	FileLimit int64              `json:"fileLimit"`
	PartSize  int64              `json:"partSize"`
	Saved     int64              `json:"saved"`
	Reserved  int64              `json:"reserved"`
}

func openSpaceReader(database string, storage *spaceStorage) (*spaceReader, error) {
	absolute, err := filepath.Abs(database)
	if err != nil {
		return nil, err
	}
	dsn := url.URL{Scheme: "file", Path: absolute, RawQuery: "mode=ro&_pragma=busy_timeout(5000)"}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	return &spaceReader{db: db, storage: storage}, nil
}

func (s *spaceReader) overview(ctx context.Context, owner string) (spaceOverview, error) {
	result := spaceOverview{
		Projects: []spaceProjectView{}, Uploads: []spaceUploadView{},
		Quota: 200_000_000, FileLimit: 100_000_000, PartSize: 16 * 1024 * 1024,
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	projects, err := tx.QueryContext(ctx, `
		SELECT p.id, p.name, CASE WHEN d.phase IS NOT NULL THEN 'deleting' ELSE '' END
		FROM space_projects p LEFT JOIN space_project_deletions d ON d.spaceId=p.id
		WHERE p.owner=? ORDER BY p.rowid DESC`, owner)
	if err != nil {
		return result, err
	}
	defer projects.Close()
	for projects.Next() {
		var project spaceProjectView
		if err := projects.Scan(&project.ID, &project.Name, &project.State); err != nil {
			return result, err
		}
		result.Projects = append(result.Projects, project)
	}
	if err := projects.Err(); err != nil {
		return result, err
	}
	uploads, err := tx.QueryContext(ctx, `
		SELECT id, project, path, size, state, expires FROM space_uploads
		WHERE owner=? AND state<>'deleted' ORDER BY rowid DESC`, owner)
	if err != nil {
		return result, err
	}
	defer uploads.Close()
	for uploads.Next() {
		var upload spaceUploadView
		if err := uploads.Scan(&upload.ID, &upload.Project, &upload.Path, &upload.Size, &upload.State, &upload.Expires); err != nil {
			return result, err
		}
		result.Uploads = append(result.Uploads, upload)
		switch upload.State {
		case "saved", "deleting":
			result.Saved += upload.Size
		case "cancelled", "expired", "failed":
		default:
			result.Reserved += upload.Size
		}
	}
	if err := uploads.Err(); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func (s *spaceReader) readableFile(ctx context.Context, owner, id string) (spaceUploadView, error) {
	var upload spaceUploadView
	err := s.db.QueryRowContext(ctx, `
		SELECT u.id, u.project, u.path, u.size, u.state, u.expires
		FROM space_uploads u
		WHERE u.owner=? AND u.id=? AND u.state='saved'
		AND NOT EXISTS (
			SELECT 1 FROM space_project_deletions d WHERE d.spaceId=u.project AND d.owner=u.owner
		)`, owner, id).Scan(&upload.ID, &upload.Project, &upload.Path, &upload.Size, &upload.State, &upload.Expires)
	if errors.Is(err, sql.ErrNoRows) {
		return spaceUploadView{}, notFound
	}
	return upload, err
}

func (s *spaceReader) routes(mux *http.ServeMux, sessions *webSessions, backend projectService) {
	register := func(pattern string, handle func(http.ResponseWriter, *http.Request, string) error) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			backend.responseHeaders(w)
			saved, err := sessions.current(r)
			if err == nil && r.Method == http.MethodHead {
				err = notFound
			}
			if err == nil {
				err = handle(w, r, saved.Owner)
			}
			if err != nil {
				authFailure(w, err)
			}
		})
	}
	register("GET /api/space", func(w http.ResponseWriter, r *http.Request, owner string) error {
		result, err := s.overview(r.Context(), owner)
		if err == nil {
			authJSON(w, http.StatusOK, result)
		}
		return err
	})
	for _, action := range []string{"preview", "download"} {
		register("GET /api/space/files/{file}/"+action, func(w http.ResponseWriter, r *http.Request, owner string) error {
			id := r.PathValue("file")
			if !taskUUID.MatchString(id) {
				return notFound
			}
			upload, err := s.readableFile(r.Context(), owner, id)
			if err != nil {
				return err
			}
			var location string
			if action == "preview" {
				if upload.Size > 256*1024 {
					return &requestFailure{413, "preview_too_large", "文件超过 256 KiB，无法预览。"}
				}
				location, err = s.storage.preview(r.Context(), spaceObjectKey(id))
			} else {
				location, err = s.storage.download(r.Context(), spaceObjectKey(id), path.Base(upload.Path))
			}
			if err != nil {
				return err
			}
			if _, err := s.readableFile(r.Context(), owner, id); err != nil {
				return err
			}
			w.Header().Set("Location", location)
			w.WriteHeader(http.StatusFound)
			return nil
		})
	}
}
