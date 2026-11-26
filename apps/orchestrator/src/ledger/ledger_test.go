package ledger

import (
	"database/sql"
	"errors"
	"path/filepath"
	"sync"
	"testing"
)

var testBinding = Binding{
	Owner: "owner-a", Workspace: "workspace-a", Session: "session-a",
	Sandbox: "sandbox-a", Volume: "volume-a",
}

func openLedger(t *testing.T, path string) *Ledger {
	t.Helper()
	l, err := Open(t.Context(), path)
	must(t, err)
	t.Cleanup(func() { _ = l.Close() })
	return l
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func wantError(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

func TestStartGrantIsConsumedOnceAcrossConnectionsAndReopen(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "runs.sqlite")
	first := openLedger(t, path)
	second := openLedger(t, path)
	_, err := first.Submit(ctx, "run-a", testBinding, "diagnose")
	must(t, err)
	_, err = first.Submit(ctx, "run-a", testBinding, "different")
	wantError(t, err, ErrTransition)

	type claim struct {
		attempt Attempt
		issued  bool
		err     error
	}
	var group sync.WaitGroup
	claims := make(chan claim, 12)
	for i := range 12 {
		group.Go(func() {
			l := first
			if i%2 == 1 {
				l = second
			}
			a, issued, err := l.ConsumeStart(ctx, "run-a", "attempt-a")
			claims <- claim{a, issued, err}
		})
	}
	group.Wait()
	close(claims)
	want := Attempt{RunID: "run-a", ID: "attempt-a", Generation: 1}
	count := 0
	for result := range claims {
		must(t, result.err)
		if result.attempt != want {
			t.Fatalf("attempt = %+v, want %+v", result.attempt, want)
		}
		if result.issued {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("start grants = %d, want 1", count)
	}
	must(t, first.Close())
	must(t, second.Close())

	reopened := openLedger(t, path)
	a, issued, err := reopened.ConsumeStart(ctx, "run-a", "attempt-a")
	must(t, err)
	if a != want || issued {
		t.Fatalf("replayed start = %+v, issued %v", a, issued)
	}
	_, _, err = reopened.ConsumeStart(ctx, "run-a", "different-attempt")
	wantError(t, err, ErrTransition)
	run, err := reopened.Run(ctx, "run-a")
	must(t, err)
	if run.Status != Starting || run.Binding != testBinding || run.Generation != 1 {
		t.Fatalf("restored run = %+v", run)
	}
}

func TestUnknownHoldsSlotUntilBothStopsAndTrustedOutcome(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "runs.sqlite")
	l := openLedger(t, path)
	_, err := l.Submit(ctx, "run-a", testBinding, "diagnose")
	must(t, err)
	_, err = l.Submit(ctx, "run-b", testBinding, "health")
	must(t, err)
	a, issued, err := l.ConsumeStart(ctx, "run-a", "attempt-a")
	must(t, err)
	if !issued {
		t.Fatal("initial start grant missing")
	}
	must(t, l.MarkRunning(ctx, a))
	must(t, l.Revoke(ctx, a))
	wantError(t, l.RecordCompletion(ctx, a, "late-receipt"), ErrStale)
	wantError(t, l.MarkRunning(ctx, a), ErrTransition)
	must(t, l.MarkUnknown(ctx, a))
	must(t, l.RecordStop(ctx, a, StopObservation{Host: "host-stop"}))
	must(t, l.Close())

	l = openLedger(t, path)
	run, err := l.Run(ctx, a.RunID)
	must(t, err)
	if run.Status != Unknown || run.Generation != a.Generation {
		t.Fatalf("restored unknown = %+v", run)
	}
	outcome := Outcome{Status: Queued, Reference: "no-effect-proof"}
	wantError(t, l.Resolve(ctx, a, outcome), ErrTransition)
	_, _, err = l.ConsumeStart(ctx, "run-b", "attempt-b")
	wantError(t, err, ErrSlotBusy)
	_, _, err = l.ConsumeStart(ctx, "run-a", "new-attempt-a")
	wantError(t, err, ErrTransition)
	must(t, l.RecordStop(ctx, a, StopObservation{Sandbox: "sandbox-stop"}))
	wantError(t, l.RecordStop(ctx, a, StopObservation{Host: "different-stop"}), ErrTransition)
	_, _, err = l.ConsumeStart(ctx, "run-b", "attempt-b")
	wantError(t, err, ErrSlotBusy)
	must(t, l.Resolve(ctx, a, outcome))
	must(t, l.Resolve(ctx, a, outcome))
	_, issued, err = l.ConsumeStart(ctx, "run-a", "attempt-a")
	must(t, err)
	if issued {
		t.Fatal("old attempt start grant was reissued")
	}
	next, issued, err := l.ConsumeStart(ctx, "run-a", "new-attempt-a")
	must(t, err)
	if !issued || next.Generation != a.Generation+1 {
		t.Fatalf("new attempt = %+v, issued %v", next, issued)
	}
	must(t, l.MarkRunning(ctx, next))
	wantError(t, l.RecordCompletion(ctx, a, "late-receipt"), ErrStale)
	wantError(t, l.RecordStop(ctx, a, StopObservation{Host: "old"}), ErrStale)
	wantError(t, l.Resolve(ctx, a, outcome), ErrStale)
}

func TestTerminalReceiptAndStateCommitTogether(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "runs.sqlite")
	l := openLedger(t, path)
	_, err := l.Submit(ctx, "run", testBinding, "health")
	must(t, err)
	a, _, err := l.ConsumeStart(ctx, "run", "attempt")
	must(t, err)
	must(t, l.MarkRunning(ctx, a))
	must(t, l.RecordCompletion(ctx, a, "execution-receipt"))
	must(t, l.RecordCompletion(ctx, a, "execution-receipt"))
	wantError(t, l.RecordCompletion(ctx, a, "different-receipt"), ErrTransition)
	must(t, l.Revoke(ctx, a))
	must(t, l.RecordStop(ctx, a, StopObservation{Host: "host-stopped", Sandbox: "sandbox-stopped"}))
	wantError(t, l.Resolve(ctx, a, Outcome{Status: Queued, Reference: "no-effect-proof"}), ErrTransition)
	wantError(t, l.Resolve(ctx, a, Outcome{Status: Succeeded, Reference: "different-receipt"}), ErrTransition)
	outcome := Outcome{Status: Succeeded, Reference: "execution-receipt"}
	must(t, l.Resolve(ctx, a, outcome))
	must(t, l.Close())
	l = openLedger(t, path)
	record, err := l.Attempt(ctx, a.RunID, a.Generation)
	must(t, err)
	if record.Attempt != a || record.Completion != outcome.Reference || record.Resolution != outcome.Reference ||
		record.Stops != (StopObservation{Host: "host-stopped", Sandbox: "sandbox-stopped"}) {
		t.Fatalf("restored attempt = %+v", record)
	}
	must(t, l.Resolve(ctx, a, outcome))
	wantError(t, l.Resolve(ctx, a, Outcome{Status: Succeeded, Reference: "different-receipt"}), ErrTransition)
	run, err := l.Run(ctx, "run")
	must(t, err)
	if run.Status != Succeeded {
		t.Fatalf("run status = %s", run.Status)
	}
	var count int
	must(t, l.db.QueryRowContext(ctx,
		"SELECT count(*) FROM receipts WHERE attempt_id = ? AND reference = ? AND status = 'succeeded'",
		a.ID, outcome.Reference).Scan(&count))
	if count != 1 {
		t.Fatalf("receipt count = %d, want 1", count)
	}
}

func TestOpenRejectsForeignDatabase(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "existing.sqlite")
	foreign, err := sql.Open("sqlite", path)
	must(t, err)
	t.Cleanup(func() { _ = foreign.Close() })
	_, err = foreign.ExecContext(ctx, "CREATE TABLE runs (id TEXT PRIMARY KEY); INSERT INTO runs VALUES ('preserved')")
	must(t, err)

	l, err := Open(ctx, path)
	if err == nil {
		_ = l.Close()
		t.Fatal("accepted another ledger's file")
	}
	var id string
	must(t, foreign.QueryRowContext(ctx, "SELECT id FROM runs").Scan(&id))
	if id != "preserved" {
		t.Fatalf("foreign row changed: %s", id)
	}
	var objects int
	must(t, foreign.QueryRowContext(ctx,
		"SELECT count(*) FROM sqlite_schema WHERE name IN ('attempts', 'receipts', 'one_execution_slot')").Scan(&objects))
	if objects != 0 {
		t.Fatalf("foreign schema changed: %d unexpected objects", objects)
	}
}

func TestTaskSubmissionRollsBackAndKeepsReceiptAcrossReopen(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "runs.sqlite")
	l := openLedger(t, path)
	_, err := l.Submit(ctx, "reserved", testBinding, "existing run")
	must(t, err)
	task := Task{ID: "task", Name: "Workspace diagnostics", Binding: testBinding}
	_, err = l.SubmitTaskRun(ctx, task, "reserved", "key", "Inspect workspace")
	wantError(t, err, ErrIdempotency)
	_, err = l.Task(ctx, task.Binding.Owner, task.ID)
	wantError(t, err, sql.ErrNoRows)

	created, err := l.SubmitTaskRun(ctx, task, "run", "key", "Inspect workspace")
	must(t, err)
	if created.Sequence != 1 || created.Replay || created.Run.ID != "run" {
		t.Fatalf("unexpected initial submission: %+v", created)
	}
	must(t, l.Close())

	l = openLedger(t, path)
	replay, err := l.SubmitTaskRun(ctx, task, "new-id", "key", "Inspect workspace")
	must(t, err)
	if !replay.Replay || replay.Run != created.Run || replay.Sequence != created.Sequence {
		t.Fatalf("unexpected replay: %+v", replay)
	}
	_, err = l.Run(ctx, "new-id")
	wantError(t, err, sql.ErrNoRows)
	_, err = l.SubmitTaskRun(ctx, task, "next-id", "next-key", "Continue")
	wantError(t, err, ErrTransition)
	must(t, l.CancelQueued(ctx, created.Run.ID))
	next, err := l.SubmitTaskRun(ctx, task, "next-id", "next-key", "Continue")
	must(t, err)
	if next.Sequence != 2 || next.Replay {
		t.Fatalf("unexpected continuation: %+v", next)
	}
}

func TestDispatchReservationExcludesOtherRunsAndSurvivesRestart(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "runs.sqlite")
	l := openLedger(t, path)
	_, err := l.SubmitTaskRun(ctx, Task{ID: "task", Name: "Task", Binding: testBinding},
		"run", "key", "Inspect")
	must(t, err)
	_, err = l.Submit(ctx, "other", testBinding, "Inspect")
	must(t, err)
	workflow, err := l.ReserveDispatch(ctx, "run")
	must(t, err)
	if workflow != "bento-run-run" {
		t.Fatal(workflow)
	}
	_, err = l.ReserveDispatch(ctx, "other")
	wantError(t, err, ErrSlotBusy)
	_, _, err = l.ConsumeStart(ctx, "other", "other-attempt")
	wantError(t, err, ErrSlotBusy)
	must(t, l.Close())
	l = openLedger(t, path)
	workflow, err = l.ReserveDispatch(ctx, "run")
	must(t, err)
	if workflow != "bento-run-run" {
		t.Fatal(workflow)
	}
	must(t, l.CancelQueued(ctx, "run"))
	_, err = l.ReserveDispatch(ctx, "other")
	must(t, err)
}
