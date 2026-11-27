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
	db                 *sql.DB
	storage            *spaceStorage
	stopReconciliation func()
	locks              *spaceLocks
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
	db, err := openSpaceDB(database, "ro")
	if err != nil {
		return nil, err
	}
	return &spaceReader{db: db, storage: storage}, nil
}

func openSpaceDB(database, mode string) (*sql.DB, error) {
	absolute, err := filepath.Abs(database)
	if err != nil {
		return nil, err
	}
	dsn := url.URL{Scheme: "file", Path: absolute, RawQuery: "mode=" + mode + "&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(FULL)"}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	return db, nil
}

func initializeSpace(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS space_projects (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS space_project_deletions (
            spaceId TEXT PRIMARY KEY, owner TEXT NOT NULL, operationId TEXT NOT NULL UNIQUE,
            executionProjectId TEXT, phase TEXT NOT NULL CHECK(phase IN ('holding','committing','releasing','cleaning','deleted')),
            lastError TEXT CHECK(lastError IN ('execution_unconfirmed','storage_unconfirmed','project_busy','project_importing','owner_closed'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS space_draining_owners (owner TEXT PRIMARY KEY) STRICT;
        CREATE TABLE IF NOT EXISTS space_retired_upload_ids (id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE IF NOT EXISTS space_uploads (
            id TEXT PRIMARY KEY, project TEXT NOT NULL, owner TEXT NOT NULL,
            path TEXT NOT NULL, size INTEGER NOT NULL, manifest TEXT NOT NULL,
            state TEXT NOT NULL, storageId TEXT, expires INTEGER NOT NULL,
            signedUntil INTEGER NOT NULL DEFAULT 0, cleanup TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS space_file_deletions (
            fileId TEXT PRIMARY KEY REFERENCES space_uploads(id) ON DELETE CASCADE,
            operationId TEXT NOT NULL, executionProjectId TEXT,
            phase TEXT NOT NULL CHECK(phase IN ('checking','deleting','releasing'))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS space_owner ON space_uploads(owner, state);
        CREATE INDEX IF NOT EXISTS space_project ON space_uploads(project, state);

        CREATE TABLE IF NOT EXISTS space_execution (
            spaceId TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL,
            state TEXT NOT NULL, inputs TEXT NOT NULL, projectId TEXT, snapshot TEXT, issues TEXT,
            PRIMARY KEY(spaceId, key)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS one_space_execution
            ON space_execution(spaceId) WHERE state <> 'failed' OR projectId IS NOT NULL;

        CREATE TABLE IF NOT EXISTS space_tasks (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, spaceId TEXT NOT NULL,
            key TEXT NOT NULL, hash TEXT NOT NULL, name TEXT NOT NULL, fileIds TEXT NOT NULL,
            state TEXT NOT NULL,canonicalBody TEXT,lastError TEXT,UNIQUE(owner,key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS space_task_inputs (
            taskId TEXT NOT NULL,fileId TEXT NOT NULL,readPinned INTEGER NOT NULL CHECK(readPinned IN (0,1)),
            PRIMARY KEY(taskId,fileId)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS space_task_file_pins ON space_task_inputs(fileId,readPinned);
    `)
	return err
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
