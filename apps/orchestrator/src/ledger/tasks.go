package ledger

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

type Task struct {
	ID, Name string
	Binding  Binding
}

type TaskSubmission struct {
	Task     Task
	Run      Run
	Sequence int64
	Replay   bool
}

func readTask(ctx context.Context, q queryer, id string) (Task, error) {
	var t Task
	err := q.QueryRowContext(ctx, `
SELECT id, name, owner, workspace, session, sandbox, volume FROM tasks WHERE id = ?`, id).
		Scan(&t.ID, &t.Name, &t.Binding.Owner, &t.Binding.Workspace, &t.Binding.Session,
			&t.Binding.Sandbox, &t.Binding.Volume)
	return t, err
}

func (l *Ledger) Task(ctx context.Context, owner, id string) (Task, error) {
	task, err := readTask(ctx, l.db, id)
	if err == nil && task.Binding.Owner != owner {
		return Task{}, sql.ErrNoRows
	}
	return task, err
}

// SubmitTaskRun commits the Task binding, Run, and idempotency receipt together.
// An existing Task's binding and name identify the same immutable input.
func (l *Ledger) SubmitTaskRun(ctx context.Context, task Task, id, key, prompt string) (TaskSubmission, error) {
	b := task.Binding
	if task.ID == "" || strings.TrimSpace(task.Name) == "" || id == "" || key == "" ||
		strings.TrimSpace(prompt) == "" || b.Owner == "" || b.Workspace == "" ||
		b.Session == "" || b.Sandbox == "" || b.Volume == "" {
		return TaskSubmission{}, ErrTransition
	}

	var result TaskSubmission
	err := l.write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
INSERT INTO tasks(id, name, owner, workspace, session, sandbox, volume)
VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
			task.ID, task.Name, b.Owner, b.Workspace, b.Session, b.Sandbox, b.Volume)
		if err != nil {
			return err
		}
		saved, err := readTask(ctx, tx, task.ID)
		if err != nil {
			return err
		}
		if saved.Binding.Owner != b.Owner {
			return sql.ErrNoRows
		}
		if saved != task {
			return ErrIdempotency
		}
		var previous string
		var sequence int64
		err = tx.QueryRowContext(ctx, `
SELECT run_id, sequence FROM task_submissions WHERE task_id = ? AND request_key = ?`, task.ID, key).
			Scan(&previous, &sequence)
		if err == nil {
			run, err := readRun(ctx, tx, previous)
			if err != nil {
				return err
			}
			if run.Prompt != prompt {
				return ErrIdempotency
			}
			result = TaskSubmission{Task: saved, Run: run, Sequence: sequence, Replay: true}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		var latest Status
		var generation int64
		err = tx.QueryRowContext(ctx, `
SELECT s.sequence, r.status, r.generation
FROM task_submissions s JOIN runs r ON r.id = s.run_id
WHERE s.task_id = ? ORDER BY s.sequence DESC LIMIT 1`, task.ID).
			Scan(&sequence, &latest, &generation)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			sequence = 0
		case err != nil:
			return err
		case latest != Succeeded && (latest != Cancelled || generation != 0):
			return ErrTransition
		}
		inserted, err := tx.ExecContext(ctx, `
INSERT INTO runs(id, owner, workspace, session, sandbox, volume, prompt, status)
VALUES (?, ?, ?, ?, ?, ?, ?, 'queued') ON CONFLICT(id) DO NOTHING`,
			id, b.Owner, b.Workspace, b.Session, b.Sandbox, b.Volume, prompt)
		if err := oneRow(inserted, err); err != nil {
			if errors.Is(err, ErrTransition) {
				return ErrIdempotency
			}
			return err
		}
		sequence++
		_, err = tx.ExecContext(ctx, `
INSERT INTO task_submissions(task_id, request_key, run_id, sequence)
VALUES (?, ?, ?, ?)`, task.ID, key, id, sequence)
		if err != nil {
			return err
		}
		run, err := readRun(ctx, tx, id)
		if err != nil {
			return err
		}
		result = TaskSubmission{Task: saved, Run: run, Sequence: sequence}
		return nil
	})
	if err != nil {
		return TaskSubmission{}, err
	}
	return result, nil
}

// AdmitWorker checks a new worker request against the current generation and
// resource binding in one read. Subsequent mutations are fenced separately.
func (l *Ledger) AdmitWorker(ctx context.Context, attempt Attempt, binding Binding) error {
	var authorized bool
	err := l.db.QueryRowContext(ctx, `
SELECT EXISTS(
    SELECT 1 FROM runs r
    JOIN attempts a ON a.run_id = r.id AND a.generation = r.generation
    WHERE r.id = ? AND a.id = ? AND a.generation = ? AND r.status = 'running'
      AND r.owner = ? AND r.workspace = ? AND r.session = ? AND r.sandbox = ? AND r.volume = ?
)`, attempt.RunID, attempt.ID, attempt.Generation, binding.Owner, binding.Workspace,
		binding.Session, binding.Sandbox, binding.Volume).Scan(&authorized)
	if err != nil {
		return err
	}
	if !authorized {
		return ErrStale
	}
	return nil
}

// ReserveDispatch persists the slot reservation before publishing Temporal.
// Retries use the original Workflow ID, including after a lost reply.
func (l *Ledger) ReserveDispatch(ctx context.Context, runID string) (string, error) {
	err := l.write(ctx, func(tx *sql.Tx) error {
		run, err := readRun(ctx, tx, runID)
		if err != nil {
			return err
		}
		if run.Status != Queued {
			return ErrTransition
		}
		var exists, occupied bool
		if err := tx.QueryRowContext(ctx, `
SELECT EXISTS(SELECT 1 FROM dispatches WHERE run_id = ?),
       EXISTS(SELECT 1 FROM dispatches WHERE pending = 1)
       OR EXISTS(SELECT 1 FROM runs WHERE status IN ('starting', 'running', 'stopping', 'unknown'))
`, runID).Scan(&exists, &occupied); err != nil {
			return err
		}
		if exists {
			return nil
		}
		if occupied {
			return ErrSlotBusy
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO dispatches(run_id, pending) VALUES (?, 1)", runID)
		return err
	})
	if err != nil {
		return "", err
	}
	return "bento-run-" + runID, nil
}
