package space

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/httpx"
)

type purgeStorageFixture struct {
	*uploadStorageFixture
	deferRemoval bool
}

func (f *purgeStorageFixture) remove(ctx context.Context, key string) error {
	if f.deferRemoval {
		return nil
	}
	return f.uploadStorageFixture.remove(ctx, key)
}

func TestGoPurgeWaitsForHorizonAndConfirmsAbsence(t *testing.T) {
	service, storage, now := uploadFixture(t)
	fixture := &purgeStorageFixture{uploadStorageFixture: storage, deferRemoval: true}
	service.storage = fixture
	ctx := t.Context()
	input := uploadReservation{id: uploadFixtureID, path: "file.txt", manifest: "[]"}
	row, err := service.reserve(ctx, "owner", "project", input)
	if err != nil {
		t.Fatal(err)
	}
	row.signedUntil = now.Add(time.Minute).UnixMilli()
	storage.exists = true
	if complete, err := service.purgeAccountObject(ctx, row); err != nil || complete || !storage.exists {
		t.Fatalf("purged before the capability expired: %v %v", complete, err)
	}
	*now = time.UnixMilli(row.signedUntil)
	if complete, err := service.purgeAccountObject(ctx, row); err == nil || complete {
		t.Fatalf("unconfirmed deletion was accepted: %v %v", complete, err)
	}
	if _, err := loadSpaceUpload(ctx, service.db, row.ID); err != nil {
		t.Fatalf("lost the upload before confirming deletion: %v", err)
	}
	fixture.deferRemoval = false
	if complete, err := service.purgeAccountObject(ctx, row); err != nil || !complete {
		t.Fatalf("confirmed deletion did not complete: %v %v", complete, err)
	}
	if _, err := loadSpaceUpload(ctx, service.db, row.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("purged upload still visible: %v", err)
	}
	if _, err := service.reserve(ctx, "owner", "project", input); !errors.Is(err, httpx.NotFound) {
		t.Fatalf("retired upload id was reusable: %v", err)
	}
}

func TestGoPurgeMetadataRequiresDurableDrainAndEmptyUploads(t *testing.T) {
	service, _, _ := uploadFixture(t)
	ctx := t.Context()
	_, err := service.db.Exec(`
		CREATE TABLE space_tasks (id TEXT PRIMARY KEY, owner TEXT);
		CREATE TABLE space_task_inputs (taskId TEXT);
		CREATE TABLE space_execution (owner TEXT);
		INSERT INTO space_tasks VALUES ('target-task','owner'), ('other-task','other');
		INSERT INTO space_task_inputs VALUES ('target-task'), ('other-task');
		INSERT INTO space_execution VALUES ('owner'), ('other');
	`)
	if err != nil {
		t.Fatal(err)
	}
	if completed, err := service.purgeAccountMetadata(ctx, "owner"); err != nil || completed {
		t.Fatalf("cleaned account without durable fence: %v %v", completed, err)
	}
	row, err := service.reserve(ctx, "owner", "project", uploadReservation{
		id: uploadFixtureID, path: "file.txt", manifest: "[]",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.db.Exec("INSERT INTO space_draining_owners VALUES ('owner')"); err != nil {
		t.Fatal(err)
	}
	if completed, err := service.purgeAccountMetadata(ctx, "owner"); err != nil || completed {
		t.Fatalf("cleaned metadata with outstanding objects: %v %v", completed, err)
	}
	if completed, err := service.purgeAccountObject(ctx, row); err != nil || !completed {
		t.Fatalf("object cleanup: %v %v", completed, err)
	}
	if completed, err := service.purgeAccountMetadata(ctx, "owner"); err != nil || !completed {
		t.Fatalf("metadata cleanup: %v %v", completed, err)
	}
	var target, other, fence, retired int
	err = service.db.QueryRow(`
		SELECT (SELECT count(*) FROM space_task_inputs WHERE taskId='target-task'),
		       (SELECT count(*) FROM space_task_inputs WHERE taskId='other-task'),
		       (SELECT count(*) FROM space_draining_owners WHERE owner='owner'),
		       (SELECT count(*) FROM space_retired_upload_ids WHERE id=?)`, row.ID).
		Scan(&target, &other, &fence, &retired)
	if err != nil || target != 0 || other != 1 || fence != 1 || retired != 1 {
		t.Fatalf("cleanup lost a fence or changed another owner: %d %d %d %d %v", target, other, fence, retired, err)
	}
}
