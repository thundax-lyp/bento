package main

import (
	"context"
	"database/sql"
	"errors"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/httpx"
	"net/http"
	"testing"
)

type deletionStorageFixture struct {
	*uploadStorageFixture
	removed int
}

func (f *deletionStorageFixture) remove(ctx context.Context, key string) error {
	f.removed++
	return f.uploadStorageFixture.remove(ctx, key)
}

func TestGoFileDeletionReconcilesHoldAndRelease(t *testing.T) {
	uploads, objects, _ := uploadFixture(t)
	storage := &deletionStorageFixture{uploadStorageFixture: objects}
	ctx := t.Context()
	if _, err := uploads.db.Exec(`
		CREATE TABLE space_file_deletions (fileId TEXT PRIMARY KEY, operationId TEXT, executionProjectId TEXT, phase TEXT);
		CREATE TABLE space_task_inputs (taskId TEXT, fileId TEXT, readPinned INTEGER);
		CREATE TABLE space_execution (spaceId TEXT, owner TEXT, state TEXT, inputs TEXT, projectId TEXT);
	`); err != nil {
		t.Fatal(err)
	}
	row, err := uploads.reserve(ctx, "owner", "project", uploadReservation{
		id: uploadFixtureID, path: "saved.txt", manifest: "[]",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := uploads.transition(ctx, &row, "saved"); err != nil {
		t.Fatal(err)
	}
	if _, err := uploads.db.Exec("INSERT INTO space_task_inputs VALUES ('task',?,1)", row.ID); err != nil {
		t.Fatal(err)
	}
	storage.exists = true
	var operations []string
	var allowHold, allowRelease bool
	service := spaceFileDeletion{
		db: uploads.db, storage: storage,
		hold: func(_ context.Context, got spaceUpload, intent fileDeletionIntent, release bool) (string, error) {
			if got.owner != row.owner || got.ID != row.ID {
				t.Fatal("deletion crossed owner or file boundary")
			}
			operations = append(operations, intent.operation)
			if release && allowRelease {
				return "released", nil
			}
			if !release && allowHold {
				return "held", nil
			}
			return "", fileDeleteUnconfirmed
		},
	}
	if _, err := service.request(ctx, "other", row.ID); !errors.Is(err, httpx.NotFound) {
		t.Fatalf("foreign file: %v", err)
	}
	if _, err := service.request(ctx, row.owner, row.ID); !errors.Is(err, fileDeleteBusy) || len(operations) != 0 {
		t.Fatalf("pinned file: %v", err)
	}
	if _, err := uploads.db.Exec("UPDATE space_task_inputs SET readPinned=0"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.request(ctx, row.owner, row.ID); !errors.Is(err, fileDeleteUnconfirmed) {
		t.Fatalf("unconfirmed hold: %v", err)
	}
	intent, err := readFileDeletion(ctx, uploads.db, row.ID)
	if err != nil || intent.phase != "checking" || !storage.exists {
		t.Fatalf("failed to persist initial intent: %#v %v", intent, err)
	}
	allowHold = true
	if status, err := service.request(ctx, row.owner, row.ID); err != nil || status != http.StatusAccepted {
		t.Fatalf("retry hold: %d %v", status, err)
	}
	row, err = loadSpaceUpload(ctx, uploads.db, row.ID)
	if err != nil || row.State != "deleting" {
		t.Fatalf("upload state after hold: %s %v", row.State, err)
	}
	if err := service.advance(ctx, row); !errors.Is(err, fileDeleteUnconfirmed) || storage.exists || storage.removed != 1 {
		t.Fatalf("lost release acknowledgement: %v, removed %d", err, storage.removed)
	}
	intent, err = readFileDeletion(ctx, uploads.db, row.ID)
	if err != nil || intent.phase != "releasing" {
		t.Fatalf("must persist the release phase: %#v %v", intent, err)
	}
	allowRelease = true
	if err := service.advance(ctx, row); err != nil || storage.removed != 1 {
		t.Fatalf("release reconciliation: %v, removed %d", err, storage.removed)
	}
	if _, err := readFileDeletion(ctx, uploads.db, row.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("completed intent remains: %v", err)
	}
	if status, err := service.request(ctx, row.owner, row.ID); err != nil || status != http.StatusNoContent {
		t.Fatalf("completed replay: %d %v", status, err)
	}
	if len(operations) != 4 || operations[0] == "" {
		t.Fatalf("unexpected hold calls: %v", operations)
	}
	for _, operation := range operations {
		if operation != operations[0] {
			t.Fatalf("operation id changed on retry: %v", operations)
		}
	}
}
