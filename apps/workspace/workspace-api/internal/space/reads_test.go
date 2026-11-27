package space

import (
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/auth"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/httpx"
)

func TestSpaceReadsScopeAndDeletion(t *testing.T) {
	database := filepath.Join(t.TempDir(), "space.sqlite")
	writer, err := sql.Open("sqlite", database)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	_, err = writer.Exec(`
		PRAGMA journal_mode=WAL;
		CREATE TABLE space_projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL);
		CREATE TABLE space_project_deletions (spaceId TEXT PRIMARY KEY, owner TEXT NOT NULL, phase TEXT NOT NULL);
		CREATE TABLE space_uploads (id TEXT PRIMARY KEY, project TEXT NOT NULL, owner TEXT NOT NULL,
			path TEXT NOT NULL, size INTEGER NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL);
		INSERT INTO space_projects VALUES ('first','owner','First'), ('second','other','Other'), ('third','owner','Third');
		INSERT INTO space_project_deletions VALUES ('third','owner','holding');
		INSERT INTO space_uploads VALUES
			('readable','first','owner','a.txt',100,'saved',0),
			('hidden','third','owner','b.txt',70,'saved',0),
			('pending','first','owner','c.txt',16,'uploading',0),
			('closed','first','owner','d.txt',80,'cancelled',0),
			('deleted','first','owner','e.txt',40,'deleted',0),
			('foreign','second','other','f.txt',500,'saved',0);
	`)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := openSpaceReader(database, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.db.Close()

	view, err := reader.overview(t.Context(), "owner")
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Projects) != 2 || view.Projects[0].ID != "third" || view.Projects[0].State != "deleting" ||
		len(view.Uploads) != 4 || view.Uploads[0].ID != "closed" || view.Saved != 170 || view.Reserved != 16 {
		t.Fatalf("unexpected owner overview: %#v", view)
	}
	for _, id := range []string{"hidden", "foreign", "pending"} {
		if _, err := reader.readableFile(t.Context(), "owner", id); !errors.Is(err, httpx.NotFound) {
			t.Fatalf("file %s should be invisible: %v", id, err)
		}
	}
	file, err := reader.readableFile(t.Context(), "owner", "readable")
	if err != nil || file.Path != "a.txt" {
		t.Fatalf("unexpected saved file: %#v, %v", file, err)
	}

	const fileID = "00000000-0000-4000-8000-000000000001"
	if _, err := writer.Exec("UPDATE space_uploads SET id=? WHERE id='readable'", fileID); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_ACCESS_KEY_ID", "fixture-access-key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "fixture-secret-key")
	t.Setenv("AWS_SESSION_TOKEN", "")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	reader.storage, err = newSpaceStorage(t.Context(), "http://127.0.0.1:8001", "fixture-bucket", "us-east-1")
	if err != nil {
		t.Fatal(err)
	}
	identity := &auth.Session{Owner: "owner", Name: "fixture@example.test"}
	current := func(*http.Request) (*auth.Session, error) { return identity, nil }
	mux := http.NewServeMux()
	reader.routes(mux, current, func(w http.ResponseWriter) { httpx.SecurityHeaders(w, "") })
	for _, tc := range []struct{ mode, parameter, value string }{
		{"preview", "response-cache-control", "no-store"},
		{"download", "response-content-disposition", "attachment; filename*=UTF-8''a.txt"},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/space/files/"+fileID+"/"+tc.mode, nil)

		response := httptest.NewRecorder()
		mux.ServeHTTP(response, req)
		location, err := url.Parse(response.Header().Get("Location"))
		if err != nil || response.Code != 302 || location.Path != "/fixture-bucket/space/"+fileID ||
			location.Query().Get(tc.parameter) != tc.value || location.Query().Get("X-Amz-Expires") != "300" {
			t.Fatalf("unexpected %s signing result: %d %v", tc.mode, response.Code, err)
		}
	}
}
