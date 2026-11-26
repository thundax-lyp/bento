package main

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestResumeAdmissionReclaimsOnlyProvenTerminalSlots(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "business.sqlite"))
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
		CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT);
		CREATE TABLE run_slot_leases(slot INTEGER PRIMARY KEY,runId TEXT);
		CREATE TABLE run_admission_drain(active INTEGER);
		CREATE TABLE physical_stop_proofs(runId TEXT,generation INTEGER,sha256 TEXT);
		CREATE TABLE physical_stop_consumption(runId TEXT,generation INTEGER,consumer TEXT,sha256 TEXT);
		INSERT INTO runs VALUES ('done','succeeded'),('review','needs_review'),('active','recovering'),('waiting','queued');
		INSERT INTO run_slot_leases VALUES (0,'done'),(1,'review'),(2,'active'),(3,'waiting');
		INSERT INTO run_admission_drain VALUES (1);
		INSERT INTO physical_stop_proofs VALUES ('review',1,'current');
		INSERT INTO physical_stop_consumption VALUES ('review',1,'slot','wrong');
	`)
	if err != nil {
		t.Fatal(err)
	}
	resume := func() {
		t.Helper()
		if _, err := businessCommand(ctx, conn, "resume-admission", businessRequest{}); err != nil {
			t.Fatal(err)
		}
	}
	count := func(query string) int {
		t.Helper()
		var n int
		if err := conn.QueryRowContext(ctx, query).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	resume()
	if count("SELECT COUNT(*) FROM run_slot_leases WHERE runId <> 'done'") != 3 ||
		count("SELECT COUNT(*) FROM run_slot_leases WHERE runId = 'done'") != 0 ||
		count("SELECT COUNT(*) FROM run_admission_drain") != 0 {
		t.Fatal("restart leaked a completed slot or released a protected slot")
	}
	if _, err := conn.ExecContext(ctx, "UPDATE physical_stop_consumption SET sha256='current'"); err != nil {
		t.Fatal(err)
	}
	resume()
	resume()
	if count("SELECT COUNT(*) FROM run_slot_leases WHERE runId IN ('active','waiting')") != 2 ||
		count("SELECT COUNT(*) FROM run_slot_leases") != 2 {
		t.Fatal("matching proof did not release the terminal slot idempotently")
	}
}
