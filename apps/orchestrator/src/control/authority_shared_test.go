package main

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestGoAuthorityHonorsSharedVolumeBoundaries(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "authority.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, err = conn.ExecContext(ctx, `
	CREATE TABLE execution_sessions (session TEXT PRIMARY KEY, tenant TEXT, project TEXT,
		sandbox TEXT, volume TEXT, generation INTEGER, state TEXT, run TEXT,
		capability TEXT, expires INTEGER, retiring INTEGER DEFAULT 0);
	CREATE UNIQUE INDEX volume_writer ON execution_sessions(volume) WHERE run IS NOT NULL;
	CREATE TABLE operations(session TEXT, state TEXT);
	CREATE TABLE volume_reclaims(volume TEXT);
	CREATE TABLE released_session_references(session TEXT);
	INSERT INTO execution_sessions(session,tenant,project,sandbox,volume,generation,state) VALUES
		('first','owner','project','first-sandbox','volume',1,'READY'),
		('second','owner','project','second-sandbox','volume',1,'READY');
	INSERT INTO volume_reclaims VALUES ('reclaiming');
	INSERT INTO released_session_references VALUES ('released');
	`)
	if err != nil {
		t.Fatal(err)
	}
	rejected := []struct{ session, volume string }{
		{"foreign", "volume"},
		{"new", "reclaiming"},
		{"released", "another-volume"},
	}
	for _, item := range rejected {
		_, err := authorityCommand(conn, "bind", path, authorityRequest{
			Session: item.session, Tenant: "owner", Project: "project",
			Sandbox: "new-sandbox", Volume: item.volume, Generation: 1, Installed: true,
		})
		if err == nil {
			t.Errorf("bound %s to %s", item.session, item.volume)
		}
	}
	first := authorityRequest{Session: "first", Generation: 1, Run: "first-run", LeaseMs: 1000}
	second := authorityRequest{Session: "second", Generation: 1, Run: "second-run", LeaseMs: 1000}
	if token, err := authorityCommand(conn, "admit", path, first); err != nil || len(token) != 64 {
		t.Fatalf("first admission failed: %v", err)
	}
	checkBusy := func() {
		t.Helper()
		if result, err := authorityCommand(conn, "admit", path, second); err != nil || result != "volume_busy" {
			t.Fatalf("second writer admitted: %v", err)
		}
	}
	checkBusy()
	_, err = conn.ExecContext(ctx, `
	UPDATE execution_sessions SET state='READY',run=NULL,capability=NULL WHERE session='first';
	INSERT INTO operations VALUES ('first','UNKNOWN');
	`)
	if err != nil {
		t.Fatal(err)
	}
	checkBusy()
	if _, err = conn.ExecContext(ctx, "UPDATE operations SET state='SUCCEEDED'"); err != nil {
		t.Fatal(err)
	}
	if token, err := authorityCommand(conn, "admit", path, second); err != nil || len(token) != 64 {
		t.Fatalf("second admission failed after reconciliation: %v", err)
	}
}
