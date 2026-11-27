package space

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/httpx"
)

const uploadFixtureID = "00000000-0000-4000-8000-000000000031"

func uploadFixture(t *testing.T) (*spaceUploads, *uploadStorageFixture, *time.Time) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "space.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	_, err = db.Exec(`
		CREATE TABLE space_projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL) STRICT;
		CREATE TABLE space_project_deletions (spaceId TEXT PRIMARY KEY, owner TEXT NOT NULL) STRICT;
		CREATE TABLE space_draining_owners (owner TEXT PRIMARY KEY) STRICT;
		CREATE TABLE space_retired_upload_ids (id TEXT PRIMARY KEY) STRICT;
		CREATE TABLE space_uploads (
			id TEXT PRIMARY KEY, project TEXT NOT NULL, owner TEXT NOT NULL,
			path TEXT NOT NULL, size INTEGER NOT NULL, manifest TEXT NOT NULL,
			state TEXT NOT NULL, storageId TEXT, expires INTEGER NOT NULL,
			signedUntil INTEGER NOT NULL DEFAULT 0, cleanup TEXT
		) STRICT;
		INSERT INTO space_projects VALUES ('project','owner','Project'), ('foreign','other','Other');
	`)
	if err != nil {
		t.Fatal(err)
	}
	store := &uploadStorageFixture{}
	now := time.Date(2026, 11, 27, 0, 0, 0, 0, time.UTC)
	return &spaceUploads{db: db, storage: store, now: func() time.Time { return now }}, store, &now
}

func TestGoUploadReservationContract(t *testing.T) {
	uploads, _, _ := uploadFixture(t)
	ctx := t.Context()
	input := uploadReservation{id: uploadFixtureID, path: "folder/a.txt", manifest: "[]"}
	row, err := uploads.reserve(ctx, "owner", "project", input)
	if err != nil || row.State != "preparing" {
		t.Fatalf("reservation: %v, %#v", err, row)
	}
	replay, err := uploads.reserve(ctx, "owner", "project", input)
	if err != nil || replay != row {
		t.Fatalf("reservation replay: %v, %#v", err, replay)
	}
	if _, err := uploads.reserve(ctx, "other", "foreign", input); !errors.Is(err, httpx.NotFound) {
		t.Fatalf("foreign account received wrong error: %v", err)
	}
	for _, next := range []uploadReservation{
		{id: input.id, path: "other.txt", manifest: "[]"},
		{id: "other-id", path: "folder", manifest: "[]"},
		{id: "other-id", path: "folder/a.txt/b.txt", manifest: "[]"},
	} {
		if _, err := uploads.reserve(ctx, "owner", "project", next); err == nil || err.Error() != "space_conflict" {
			t.Fatalf("should reject changed reservation or path collision: %v", err)
		}
	}
	if _, err := uploads.db.Exec("UPDATE space_uploads SET size=? WHERE id=?", spaceQuota, input.id); err != nil {
		t.Fatal(err)
	}
	if _, err := uploads.reserve(ctx, "owner", "project", uploadReservation{id: "quota-id", path: "z.txt", size: 1}); err == nil || err.Error() != "space_quota" {
		t.Fatalf("quota exceeded: %v", err)
	}
}

func TestGoUploadCompletionRecoversLostResponse(t *testing.T) {
	uploads, storage, _ := uploadFixture(t)
	ctx := t.Context()
	checksum := base64.StdEncoding.EncodeToString(make([]byte, 32))
	fields := map[string]json.RawMessage{
		"id": json.RawMessage(`"` + uploadFixtureID + `"`), "path": json.RawMessage(`"a.txt"`),
		"size": json.RawMessage("3"), "checksums": json.RawMessage(`["` + checksum + `"]`),
	}
	input, err := parseUploadReservation(fields)
	if err != nil {
		t.Fatal(err)
	}
	row, err := uploads.reserve(ctx, "owner", "project", input)
	if err != nil {
		t.Fatal(err)
	}
	_, signed, err := uploads.signPart(ctx, &row, 1)
	if err != nil || signed != checksum || row.signedUntil != uploads.now().Add(partURLLifetime+5*time.Second).UnixMilli() {
		t.Fatalf("signed part: %v, %q, %d", err, signed, row.signedUntil)
	}
	storage.accepted = []types.Part{
		{PartNumber: aws.Int32(1), Size: aws.Int64(3), ETag: aws.String("etag"), ChecksumSHA256: &checksum},
	}
	storage.finalSize, storage.loseComplete = 3, true
	if err := uploads.finish(ctx, &row); !errors.Is(err, uploadFixtureLostResponse) {
		t.Fatalf("expected missing completion acknowledgement, got %v", err)
	}
	row, err = loadSpaceUpload(ctx, uploads.db, row.ID)
	if err != nil || row.State != "completing" {
		t.Fatalf("state after missing response: %v, %s", err, row.State)
	}
	if err := uploads.finish(ctx, &row); err != nil || row.State != "saved" || storage.completeCalls != 1 {
		t.Fatalf("retry did not reconcile the existing object: %v, %s, %d", err, row.State, storage.completeCalls)
	}
}

func TestGoUploadCleanupWaitsForSignedPart(t *testing.T) {
	uploads, storage, now := uploadFixture(t)
	ctx := t.Context()
	checksum := base64.StdEncoding.EncodeToString(make([]byte, 32))
	input := uploadReservation{id: uploadFixtureID, path: "a.txt", size: 1, manifest: `["` + checksum + `"]`}
	row, err := uploads.reserve(ctx, "owner", "project", input)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := uploads.signPart(ctx, &row, 1); err != nil {
		t.Fatal(err)
	}
	storage.exists = true
	before := storage.abortCalls
	if err := uploads.clean(ctx, &row, "cancelled"); err != nil || row.State != "cleaning" ||
		storage.abortCalls != before || !storage.exists {
		t.Fatalf("cleaned before signed capability expired: %v, %s", err, row.State)
	}
	*now = time.UnixMilli(row.signedUntil)
	if err := uploads.clean(ctx, &row, "expired"); err != nil || row.State != "cancelled" ||
		storage.abortCalls != before+1 || storage.exists {
		t.Fatalf("failed to preserve durable cleanup outcome: %v, %s", err, row.State)
	}
}

var uploadFixtureLostResponse = errors.New("fixture lost completion response")

type uploadStorageFixture struct {
	accepted                  []types.Part
	finalSize                 int64
	exists, loseComplete      bool
	abortCalls, completeCalls int
}

func (f *uploadStorageFixture) abort(context.Context, string, string) error {
	f.abortCalls++
	return nil
}
func (*uploadStorageFixture) create(context.Context, string) (string, error) { return "multipart", nil }
func (*uploadStorageFixture) signPart(context.Context, string, string, int32, int64, string) (string, error) {
	return "https://fixture.invalid/part", nil
}
func (f *uploadStorageFixture) parts(context.Context, string, string) ([]types.Part, bool, error) {
	return f.accepted, true, nil
}
func (f *uploadStorageFixture) size(context.Context, string) (int64, bool, error) {
	return f.finalSize, f.exists, nil
}
func (f *uploadStorageFixture) complete(_ context.Context, _, _ string, parts []types.CompletedPart) error {
	if len(parts) != 1 {
		return errors.New("invalid fixture completion")
	}
	f.completeCalls++
	f.exists = true
	if f.loseComplete {
		return uploadFixtureLostResponse
	}
	return nil
}
func (f *uploadStorageFixture) empty(context.Context, string) error  { f.exists = true; return nil }
func (f *uploadStorageFixture) remove(context.Context, string) error { f.exists = false; return nil }
