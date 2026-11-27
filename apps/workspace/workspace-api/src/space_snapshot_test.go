package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
)

func TestGoFreezeSnapshotPreservesCanonicalInput(t *testing.T) {
	uploads, _, _ := uploadFixture(t)
	ctx := t.Context()
	if _, err := uploads.db.Exec(`
		CREATE TABLE space_tasks (
			id TEXT PRIMARY KEY, owner TEXT, spaceId TEXT, name TEXT, fileIds TEXT, state TEXT, canonicalBody TEXT
		);
		CREATE TABLE space_file_deletions (fileId TEXT PRIMARY KEY);
	`); err != nil {
		t.Fatal(err)
	}
	const taskID = "00000000-0000-4000-8000-000000000041"
	const path = "readme.txt"
	const text = "\ufeff<&\u2028\u2029\n"
	digest := sha256.Sum256([]byte(text))
	manifest := `["` + base64.StdEncoding.EncodeToString(digest[:]) + `"]`
	up, err := uploads.reserve(ctx, "owner", "project", uploadReservation{
		id: uploadFixtureID, path: path, size: int64(len(text)), manifest: manifest,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := uploads.transition(ctx, &up, "saved"); err != nil {
		t.Fatal(err)
	}
	if _, err := uploads.db.Exec("INSERT INTO space_tasks VALUES (?,?,?,?,?,'pinned',NULL)",
		taskID, "owner", "project", "Snapshot", `["`+up.ID+`"]`); err != nil {
		t.Fatal(err)
	}
	service := spaceSnapshots{
		db: uploads.db,
		read: func(_ context.Context, key string, size int64) ([]byte, error) {
			if key != spaceObjectKey(up.ID) || size != int64(len(text)) {
				t.Fatal("unexpected snapshot object or size")
			}
			return []byte(text), nil
		},
	}
	if err := service.freeze(ctx, "other", taskID); !errors.Is(err, notFound) {
		t.Fatalf("foreign snapshot: %v", err)
	}
	if err := service.freeze(ctx, "owner", taskID); err != nil {
		t.Fatal(err)
	}
	var state, encoded string
	if err := uploads.db.QueryRow("SELECT state,canonicalBody FROM space_tasks WHERE id=?", taskID).Scan(&state, &encoded); err != nil {
		t.Fatal(err)
	}
	var body struct {
		InputFiles  []projectFile
		InputDigest string
	}
	// JSON.stringify keeps HTML, Unicode separators and a leading BOM in file text.
	canonical := "[{\"path\":\"readme.txt\",\"text\":\"\ufeff<&\u2028\u2029\\n\"}]"
	expected := sha256.Sum256([]byte(canonical))
	if err := json.Unmarshal([]byte(encoded), &body); err != nil || state != "frozen" ||
		len(body.InputFiles) != 1 || body.InputFiles[0].Text != text ||
		body.InputDigest != hex.EncodeToString(expected[:]) {
		t.Fatalf("invalid frozen payload: %s %v", state, err)
	}
	if err := service.freeze(ctx, "owner", taskID); err != nil {
		t.Fatalf("frozen retry should be idempotent: %v", err)
	}
}
