package main

import (
	"errors"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/httpx"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGoProjectDeletionRetainsOperationThroughCommit(t *testing.T) {
	uploads, storage, _ := uploadFixture(t)
	ctx := t.Context()
	if _, err := uploads.db.Exec(`
		ALTER TABLE space_project_deletions ADD COLUMN operationId TEXT;
		ALTER TABLE space_project_deletions ADD COLUMN executionProjectId TEXT;
		ALTER TABLE space_project_deletions ADD COLUMN phase TEXT;
		ALTER TABLE space_project_deletions ADD COLUMN lastError TEXT;
		CREATE TABLE space_file_deletions (fileId TEXT PRIMARY KEY);
		CREATE TABLE space_execution (spaceId TEXT, owner TEXT, state TEXT, projectId TEXT);
		CREATE TABLE space_tasks (id TEXT, owner TEXT, spaceId TEXT);
		CREATE TABLE space_task_inputs (taskId TEXT);
	`); err != nil {
		t.Fatal(err)
	}
	file, err := uploads.reserve(ctx, "owner", "project", uploadReservation{
		id: uploadFixtureID, path: "file.txt", manifest: "[]",
	})
	if err != nil {
		t.Fatal(err)
	}
	var operation string
	commits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/v1/task-sources/project" || r.Header.Get("X-Bento-Owner-Id") != "owner" {
			t.Error("wrong upstream delete scope")
			w.WriteHeader(400)
			return
		}
		key := r.Header.Get("Idempotency-Key")
		if operation == "" {
			operation = key
		}
		if key != operation || !taskUUID.MatchString(key) {
			t.Error("project deletion operation id changed")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Query().Get("phase") {
		case "hold":
			w.WriteHeader(202)
			_, _ = w.Write([]byte(`{"state":"held"}`))
		case "commit":
			commits++
			if commits == 1 {
				w.WriteHeader(202)
				_, _ = w.Write([]byte(`{"state":"deleting"}`))
			} else {
				w.WriteHeader(204)
			}
		}
	}))
	defer upstream.Close()
	service := spaceProjectDeletion{db: uploads.db, storage: storage, locks: &spaceLocks{}, backend: projectService{origin: upstream.URL, client: upstream.Client()}}
	if err := service.enroll(ctx, "other", "project"); !errors.Is(err, httpx.NotFound) {
		t.Fatalf("foreign project: %v", err)
	}
	if err := service.enroll(ctx, "owner", "project"); err == nil || err.Error() != "upload_pending" {
		t.Fatalf("project with pending upload: %v", err)
	}
	if err := uploads.transition(ctx, &file, "saved"); err != nil {
		t.Fatal(err)
	}
	storage.exists = true
	if err := service.enroll(ctx, "owner", "project"); err != nil {
		t.Fatal(err)
	}
	if status, err := service.advance(ctx, "owner", "project"); err != nil || status != 202 || !storage.exists {
		t.Fatalf("removed file before upstream commit: %d %v", status, err)
	}
	for range 2 {
		if status, err := service.advance(ctx, "owner", "project"); err != nil || status != 204 || storage.exists {
			t.Fatalf("project did not finish or replay: %d %v", status, err)
		}
	}
	var retired int
	if err := uploads.db.QueryRow("SELECT count(*) FROM space_retired_upload_ids WHERE id=?", file.ID).Scan(&retired); err != nil || retired != 1 {
		t.Fatalf("missing retired file id: %d %v", retired, err)
	}
}
