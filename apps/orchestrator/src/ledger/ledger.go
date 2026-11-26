// Package ledger persists Run and execution-attempt state for the Go Orchestrator.
package ledger

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

type Status string

const (
	Queued    Status = "queued"
	Starting  Status = "starting"
	Running   Status = "running"
	Stopping  Status = "stopping"
	Unknown   Status = "unknown"
	Succeeded Status = "succeeded"
	Failed    Status = "failed"
	Cancelled Status = "cancelled"
)

var (
	ErrTransition  = errors.New("run transition refused")
	ErrStale       = errors.New("stale attempt or generation")
	ErrSlotBusy    = errors.New("execution slot occupied")
	ErrIdempotency = errors.New("idempotency key belongs to a different request")
)

type Binding struct {
	Owner, Workspace, Session, Sandbox, Volume string
}

type Run struct {
	ID, Prompt string
	Binding    Binding
	Status     Status
	Generation int64
}

type Attempt struct {
	RunID, ID  string
	Generation int64
}

type Ledger struct {
	db *sql.DB
}

const applicationID = 1112429647
const schemaVersion = 3

const schema = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    owner TEXT NOT NULL,
    workspace TEXT NOT NULL,
    session TEXT NOT NULL,
    sandbox TEXT NOT NULL,
    volume TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY NOT NULL,
    owner TEXT NOT NULL,
    workspace TEXT NOT NULL,
    session TEXT NOT NULL,
    sandbox TEXT NOT NULL,
    volume TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN
       ('queued', 'starting', 'running', 'stopping', 'unknown', 'succeeded', 'failed', 'cancelled')),
    generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
CREATE TABLE IF NOT EXISTS task_submissions (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    request_key TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    PRIMARY KEY (task_id, request_key),
    UNIQUE (task_id, sequence)
);
CREATE TABLE IF NOT EXISTS dispatches (
    run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),
    pending INTEGER NOT NULL CHECK (pending IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_dispatch_reservation ON dispatches (pending) WHERE pending = 1;
CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    host_stop TEXT,
    sandbox_stop TEXT,
    completion TEXT,
    resolution TEXT,
    UNIQUE (run_id, generation)
);
CREATE TABLE IF NOT EXISTS receipts (
    attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(id),
    reference TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_execution_slot ON runs ((1))
WHERE status IN ('starting', 'running', 'stopping', 'unknown');
`

func Open(ctx context.Context, path string) (*Ledger, error) {
	if path == "" {
		return nil, errors.New("ledger path required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	file, err := os.OpenFile(absolute, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		if err = file.Close(); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	address := url.URL{Scheme: "file", Path: absolute,
		RawQuery: "mode=rw&_pragma=busy_timeout(5000)&_pragma=synchronous(FULL)&_pragma=foreign_keys(1)&_txlock=immediate"}
	db, err := sql.Open("sqlite", address.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	l := &Ledger{db: db}
	if err = l.initialize(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize run ledger: %w", err)
	}
	return l, nil
}

func (l *Ledger) initialize(ctx context.Context) error {
	if err := l.write(ctx, func(tx *sql.Tx) error {
		var appID, version int
		if err := tx.QueryRowContext(ctx, "PRAGMA application_id").Scan(&appID); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
			return err
		}
		if appID == applicationID && version == schemaVersion {
			return nil
		}
		if appID == applicationID && (version == 1 || version == 2) {
			// The added tables leave existing Run rows intact.
			_, err := tx.ExecContext(ctx, schema+fmt.Sprintf("PRAGMA user_version=%d;", schemaVersion))
			return err
		}
		var populated bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema)").Scan(&populated); err != nil {
			return err
		}
		if appID != 0 || version != 0 || populated {
			return errors.New("file is not an empty or supported Go Run ledger")
		}
		_, err := tx.ExecContext(ctx, schema+fmt.Sprintf("PRAGMA application_id=%d; PRAGMA user_version=%d;", applicationID, schemaVersion))
		return err
	}); err != nil {
		return err
	}
	var mode string
	if err := l.db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&mode); err != nil {
		return err
	}
	if mode != "wal" {
		return fmt.Errorf("unexpected SQLite journal mode: %s", mode)
	}
	return nil
}

func (l *Ledger) Close() error { return l.db.Close() }

func (l *Ledger) Submit(ctx context.Context, id string, b Binding, prompt string) (Run, error) {
	if id == "" || b.Owner == "" || b.Workspace == "" || b.Session == "" || b.Sandbox == "" || b.Volume == "" || prompt == "" {
		return Run{}, ErrTransition
	}
	err := l.write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
INSERT INTO runs(id, owner, workspace, session, sandbox, volume, prompt, status)
VALUES (?, ?, ?, ?, ?, ?, ?, 'queued') ON CONFLICT(id) DO NOTHING`,
			id, b.Owner, b.Workspace, b.Session, b.Sandbox, b.Volume, prompt)
		if err != nil {
			return err
		}
		run, err := readRun(ctx, tx, id)
		if err != nil {
			return err
		}
		if run.Binding != b || run.Prompt != prompt {
			return ErrTransition
		}
		return nil
	})
	if err != nil {
		return Run{}, err
	}
	return l.Run(ctx, id)
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (l *Ledger) Run(ctx context.Context, id string) (Run, error) {
	return readRun(ctx, l.db, id)
}

func readRun(ctx context.Context, q queryer, id string) (Run, error) {
	var r Run
	err := q.QueryRowContext(ctx, `
SELECT id, owner, workspace, session, sandbox, volume, prompt, status, generation
FROM runs WHERE id = ?`, id).Scan(
		&r.ID, &r.Binding.Owner, &r.Binding.Workspace, &r.Binding.Session,
		&r.Binding.Sandbox, &r.Binding.Volume, &r.Prompt, &r.Status, &r.Generation)
	return r, err
}

// ConsumeStart records the sole grant to start this attempt before control I/O.
// Only a newly committed grant authorizes issuing a start request.
func (l *Ledger) ConsumeStart(ctx context.Context, runID, attemptID string) (Attempt, bool, error) {
	if attemptID == "" {
		return Attempt{}, false, ErrTransition
	}
	var result Attempt
	issued := false
	err := l.write(ctx, func(tx *sql.Tx) error {
		var previous Attempt
		err := tx.QueryRowContext(ctx, "SELECT run_id, id, generation FROM attempts WHERE id = ?", attemptID).
			Scan(&previous.RunID, &previous.ID, &previous.Generation)
		if err == nil {
			if previous.RunID != runID {
				return ErrStale
			}
			result = previous
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		run, err := readRun(ctx, tx, runID)
		if err != nil {
			return err
		}
		if run.Status != Queued {
			return ErrTransition
		}
		var occupied bool
		if err := tx.QueryRowContext(ctx, `
SELECT EXISTS(
    SELECT 1 FROM runs WHERE status IN ('starting', 'running', 'stopping', 'unknown')
    UNION ALL SELECT 1 FROM dispatches WHERE pending = 1 AND run_id <> ?
)`, runID).Scan(&occupied); err != nil {
			return err
		}
		if occupied {
			return ErrSlotBusy
		}
		var missingDispatch bool
		if err := tx.QueryRowContext(ctx, `
SELECT EXISTS(SELECT 1 FROM task_submissions WHERE run_id = ?)
   AND NOT EXISTS(SELECT 1 FROM dispatches WHERE run_id = ?)`, runID, runID).Scan(&missingDispatch); err != nil {
			return err
		}
		if missingDispatch {
			return ErrTransition
		}
		if _, err := tx.ExecContext(ctx, "UPDATE dispatches SET pending = 0 WHERE run_id = ?", runID); err != nil {
			return err
		}
		result = Attempt{RunID: run.ID, ID: attemptID, Generation: run.Generation + 1}
		if _, err := tx.ExecContext(ctx, "UPDATE runs SET generation = ?, status = 'starting' WHERE id = ?", result.Generation, runID); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO attempts(id, run_id, generation) VALUES (?, ?, ?)", attemptID, runID, result.Generation)
		issued = err == nil
		return err
	})
	if err != nil {
		return Attempt{}, false, err
	}
	return result, issued, nil
}

func (l *Ledger) MarkRunning(ctx context.Context, a Attempt) error {
	return l.write(ctx, func(tx *sql.Tx) error {
		status, err := current(ctx, tx, a)
		if err != nil {
			return err
		}
		if status == Running {
			return nil
		}
		if status != Starting {
			return ErrTransition
		}
		return setStatus(ctx, tx, a.RunID, Running)
	})
}

// Revoke closes the generation's authority before either stop is observed.
func (l *Ledger) Revoke(ctx context.Context, a Attempt) error {
	return l.write(ctx, func(tx *sql.Tx) error {
		status, err := current(ctx, tx, a)
		if err != nil {
			return err
		}
		switch status {
		case Stopping, Unknown:
			return nil
		case Starting, Running:
			return setStatus(ctx, tx, a.RunID, Stopping)
		default:
			return ErrTransition
		}
	})
}

// RecordCompletion stores the worker receipt while the current attempt can
// still write. The controller settles the Run after both stops are observed.
func (l *Ledger) RecordCompletion(ctx context.Context, a Attempt, reference string) error {
	if reference == "" {
		return ErrTransition
	}
	return l.write(ctx, func(tx *sql.Tx) error {
		status, err := current(ctx, tx, a)
		if err != nil {
			return err
		}
		if status != Running {
			return ErrStale
		}
		result, err := tx.ExecContext(ctx, `
UPDATE attempts SET completion = ? WHERE id = ? AND (completion IS NULL OR completion = ?)`,
			reference, a.ID, reference)
		return oneRow(result, err)
	})
}

type AttemptRecord struct {
	Attempt
	Stops                  StopObservation
	Completion, Resolution string
}

func (l *Ledger) Attempt(ctx context.Context, runID string, generation int64) (AttemptRecord, error) {
	var r AttemptRecord
	err := l.db.QueryRowContext(ctx, `
SELECT run_id, id, generation, COALESCE(host_stop, ''), COALESCE(sandbox_stop, ''),
       COALESCE(completion, ''), COALESCE(resolution, '')
FROM attempts WHERE run_id = ? AND generation = ?`, runID, generation).Scan(
		&r.RunID, &r.ID, &r.Generation, &r.Stops.Host, &r.Stops.Sandbox, &r.Completion, &r.Resolution)
	return r, err
}

func (l *Ledger) MarkUnknown(ctx context.Context, a Attempt) error {
	return l.write(ctx, func(tx *sql.Tx) error {
		status, err := current(ctx, tx, a)
		if err != nil {
			return err
		}
		if status == Unknown {
			return nil
		}
		if status != Stopping {
			return ErrTransition
		}
		return setStatus(ctx, tx, a.RunID, Unknown)
	})
}

type StopObservation struct {
	Host, Sandbox string
}

// RecordStop retains independently obtained, attempt-scoped stop references.
// Repeated observations must agree with the already recorded evidence.
func (l *Ledger) RecordStop(ctx context.Context, a Attempt, proof StopObservation) error {
	if proof == (StopObservation{}) {
		return ErrTransition
	}
	return l.write(ctx, func(tx *sql.Tx) error {
		status, err := current(ctx, tx, a)
		if err != nil {
			return err
		}
		if status != Stopping && status != Unknown {
			return ErrTransition
		}
		result, err := tx.ExecContext(ctx, `
UPDATE attempts
SET host_stop = COALESCE(host_stop, NULLIF(?, '')),
    sandbox_stop = COALESCE(sandbox_stop, NULLIF(?, ''))
WHERE id = ? AND (host_stop IS NULL OR ? IN ('', host_stop))
             AND (sandbox_stop IS NULL OR ? IN ('', sandbox_stop))`,
			proof.Host, proof.Sandbox, a.ID, proof.Host, proof.Sandbox)
		return oneRow(result, err)
	})
}

type Outcome struct {
	Status    Status
	Reference string
}

// Resolve closes the original attempt after both sides have stopped and a
// trusted observer supplies a terminal outcome or affirmative no-effect proof.
func (l *Ledger) Resolve(ctx context.Context, a Attempt, outcome Outcome) error {
	if outcome.Reference == "" {
		return ErrTransition
	}
	switch outcome.Status {
	case Queued, Succeeded, Failed, Cancelled:
	default:
		return ErrTransition
	}
	return l.write(ctx, func(tx *sql.Tx) error {
		status, err := current(ctx, tx, a)
		if err != nil {
			return err
		}
		if (status != Stopping && status != Unknown) && status != outcome.Status {
			return ErrTransition
		}
		if status == outcome.Status {
			var previous string
			err := tx.QueryRowContext(ctx, "SELECT COALESCE(resolution, '') FROM attempts WHERE id = ?", a.ID).Scan(&previous)
			if err != nil {
				return err
			}
			if previous != outcome.Reference {
				return ErrTransition
			}
			return nil
		}
		result, err := tx.ExecContext(ctx, `
UPDATE attempts SET resolution = ?
WHERE id = ? AND host_stop IS NOT NULL AND sandbox_stop IS NOT NULL AND resolution IS NULL
  AND (completion IS NULL OR (? = 'succeeded' AND completion = ?))`,
			outcome.Reference, a.ID, outcome.Status, outcome.Reference)
		if err := oneRow(result, err); err != nil {
			return err
		}
		if outcome.Status != Queued {
			if _, err := tx.ExecContext(ctx, "INSERT INTO receipts(attempt_id, reference, status) VALUES (?, ?, ?)",
				a.ID, outcome.Reference, outcome.Status); err != nil {
				return err
			}
		}
		return setStatus(ctx, tx, a.RunID, outcome.Status)
	})
}

func (l *Ledger) CancelQueued(ctx context.Context, runID string) error {
	return l.write(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, "UPDATE runs SET status = 'cancelled' WHERE id = ? AND status IN ('queued', 'cancelled')", runID)
		if err := oneRow(result, err); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE dispatches SET pending = 0 WHERE run_id = ?", runID)
		return err
	})
}

func current(ctx context.Context, tx *sql.Tx, a Attempt) (Status, error) {
	var status Status
	err := tx.QueryRowContext(ctx, `
SELECT r.status FROM runs r JOIN attempts a ON a.run_id = r.id AND a.generation = r.generation
WHERE r.id = ? AND a.id = ? AND a.generation = ?`, a.RunID, a.ID, a.Generation).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrStale
	}
	return status, err
}

func setStatus(ctx context.Context, tx *sql.Tx, id string, status Status) error {
	_, err := tx.ExecContext(ctx, "UPDATE runs SET status = ? WHERE id = ?", status, id)
	return err
}

func oneRow(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrTransition
	}
	return nil
}

func (l *Ledger) write(ctx context.Context, apply func(*sql.Tx) error) error {
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := apply(tx); err != nil {
		return err
	}
	return tx.Commit()
}
