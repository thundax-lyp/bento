package main

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const dispatchInterval = 250 * time.Millisecond
const pendingDispatch = `(r.status IN ` + activeRuns + `
	OR (r.status='queued' AND d.runId IS NOT NULL))`

func openDispatchLedger(ctx context.Context, path string) (*sql.DB, *sql.Conn, error) {
	if !filepath.IsAbs(path) || filepath.Base(path) != "business.sqlite" {
		return nil, nil, errors.New("invalid dispatch ledger path")
	}
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
		return nil, nil, errors.New("dispatch ledger unavailable")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, nil, err
	}
	conn, err := db.Conn(ctx)
	if err == nil {
		_, err = conn.ExecContext(ctx, "PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON")
	}
	if err != nil {
		if conn != nil {
			_ = conn.Close()
		}
		_ = db.Close()
		return nil, nil, err
	}
	return db, conn, nil
}

// SQLite serializes this write statement with the other writers of the ledger.
// An idle tenant wins before any occupied tenant, with FIFO within each group.
func reserveNextDispatch(ctx context.Context, db *sql.Conn, slots int) (string, error) {
	var id string
	err := db.QueryRowContext(ctx, `WITH occupied AS (
		SELECT p.owner,r.status FROM runs r JOIN projects p ON p.id=r.projectId
		LEFT JOIN run_dispatches d ON d.runId=r.id
		WHERE r.status IN `+activeRuns+` OR (r.status='queued' AND d.runId IS NOT NULL)
		OR EXISTS(SELECT 1 FROM run_slot_leases l WHERE l.runId=r.id)
	)
	INSERT INTO run_dispatches(runId)
	SELECT r.id FROM runs r JOIN projects p ON p.id=r.projectId
	WHERE r.status='queued'
	AND NOT EXISTS(SELECT 1 FROM run_admission_drain)
	AND NOT EXISTS(SELECT 1 FROM run_dispatches WHERE runId=r.id)
	AND NOT EXISTS(SELECT 1 FROM occupied WHERE owner=p.owner AND status='queued')
	AND (SELECT COUNT(*) FROM occupied) < ?
	ORDER BY EXISTS(SELECT 1 FROM occupied WHERE owner=p.owner), r.rowid
	LIMIT 1 RETURNING runId`, slots).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

type runDispatcher struct {
	db        *sql.Conn
	publisher workflowPublisher
	queue     string
	slots     int
	published map[string]bool
	// Avoid racing Workflow publication against deletion through the bridge.
	publication sync.Mutex
}

func (d *runDispatcher) tick(ctx context.Context) error {
	for i := 0; i < d.slots; i++ {
		id, err := reserveNextDispatch(ctx, d.db, d.slots)
		if err != nil {
			return err
		}
		if id == "" {
			break
		}
	}
	rows, err := d.db.QueryContext(ctx, `SELECT r.id FROM runs r
		LEFT JOIN run_dispatches d ON d.runId=r.id WHERE `+pendingDispatch+`
		ORDER BY r.status='queued', d.rowid, r.rowid`)
	if err != nil {
		return err
	}
	var pending []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		pending = append(pending, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	previous := d.published
	d.published = make(map[string]bool, len(pending))
	for _, id := range pending {
		if previous[id] {
			d.published[id] = true
		}
	}
	for _, id := range pending {
		if d.published[id] {
			continue
		}
		d.publication.Lock()
		published, err := d.publishPending(ctx, id)
		d.publication.Unlock()
		if err != nil {
			return err
		}
		if published {
			d.published[id] = true
		}
	}
	return nil
}

func (d *runDispatcher) publishPending(ctx context.Context, id string) (bool, error) {
	var exists int
	err := d.db.QueryRowContext(ctx, `SELECT 1 FROM runs r
		LEFT JOIN run_dispatches d ON d.runId=r.id WHERE r.id=? AND `+pendingDispatch, id).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	err = publishRunWorkflow(ctx, d.publisher, d.queue, workflowID(id), id)
	return err == nil, err
}

func (d *runDispatcher) start() func() {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(dispatchInterval)
		defer ticker.Stop()
		for ctx.Err() == nil {
			// Reservations survive a failed publication and are searched again on the next tick.
			_ = d.tick(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

func workflowID(runID string) string { return "bento-run-" + runID }
