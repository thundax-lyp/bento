package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"time"
)

type businessRequest struct {
	Session         string
	Run             string
	Project         string
	Slots           int
	Generation      int64
	Status          string
	Summary         string
	Diff            *string
	Baseline        string
	Body            string
	Proof           string
	CreatedAt       string
	Owner           string
	Key             string
	Prompt          string
	Task            bool
	Diagnostic      bool
	RequireApproval bool
	QueueLimit      int
	Attempt         string
	SourceRun       string
	NewGeneration   int64
	WorkspaceSHA256 string
	HistorySHA256   string
}

const activeRuns = "('running','recovering','cancelling')"

func runBusiness(path, action string) error {
	if !filepath.IsAbs(path) || filepath.Base(path) != "business.sqlite" {
		return errAuthority
	}
	var req businessRequest
	dec := json.NewDecoder(io.LimitReader(os.Stdin, 16<<20))
	dec.DisallowUnknownFields()
	if dec.Decode(&req) != nil || dec.Decode(new(any)) != io.EOF {
		return errAuthority
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return errAuthority
	}
	defer db.Close()
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return errAuthority
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON"); err != nil {
		return errAuthority
	}
	out, err := businessCommand(ctx, conn, action, req)
	if err != nil {
		return errAuthority
	}
	return json.NewEncoder(os.Stdout).Encode(out)
}

const releaseSlotSQL = `DELETE FROM run_slot_leases WHERE EXISTS(
			SELECT 1 FROM runs WHERE id=run_slot_leases.runId AND status NOT IN ('running','recovering','cancelling'))
			AND NOT EXISTS (SELECT 1 FROM physical_stop_proofs p WHERE p.runId=run_slot_leases.runId
				AND NOT EXISTS (SELECT 1 FROM physical_stop_consumption c WHERE c.runId=p.runId
					AND c.generation=p.generation AND c.consumer='slot' AND c.sha256=p.sha256))`

func businessCommand(ctx context.Context, db *sql.Conn, action string, r businessRequest) (any, error) {
	if r.Run == "" && action != "drain" && action != "begin-drain" && action != "resume-admission" && action != "drain-owner" {
		return nil, errAuthority
	}
	if (action == "reserve" || action == "start" || action == "acquire") && (r.Slots < 1 || r.Slots > 2) {
		return nil, errAuthority
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	exec := func(query string, args ...any) (bool, error) {
		result, err := db.ExecContext(ctx, query, args...)
		reserved, err := reservation(result, err)
		return reserved == "reserved", err
	}
	switch action {
	case "drain-owner":
		if r.Owner == "" {
			return false, errAuthority
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return false, err
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO draining_owners VALUES (?)", r.Owner); err != nil {
			return false, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE runs SET status='cancelled',
			summary='Account closed before approval.',updatedAt=?
			WHERE status='pending_approval' AND projectId IN (SELECT id FROM projects WHERE owner=?)`, now, r.Owner); err != nil {
			return false, err
		}
		return true, tx.Commit()
	case "begin-drain":
		return exec("INSERT OR IGNORE INTO run_admission_drain VALUES (1)")
	case "resume-admission":
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		// The caller holds the execution controller lock. Queued Runs keep their reservations.
		if _, err = tx.ExecContext(ctx, releaseSlotSQL+` AND EXISTS (
			SELECT 1 FROM runs WHERE id=run_slot_leases.runId AND status<>'queued'
		)`); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM run_admission_drain"); err != nil {
			return nil, err
		}
		return true, tx.Commit()
	case "reserve":
		return exec(`WITH occupied AS (
			SELECT p.owner,r.status FROM runs r JOIN projects p ON p.id=r.projectId
			LEFT JOIN run_dispatches d ON d.runId=r.id
			WHERE r.status IN `+activeRuns+` OR (r.status='queued' AND d.runId IS NOT NULL)
			OR EXISTS(SELECT 1 FROM run_slot_leases l WHERE l.runId=r.id)
		)
		INSERT INTO run_dispatches(runId)
		SELECT r.id FROM runs r JOIN projects p ON p.id=r.projectId
		WHERE r.id=? AND r.status='queued'
		AND NOT EXISTS (SELECT 1 FROM run_admission_drain)
		AND NOT EXISTS(SELECT 1 FROM run_dispatches WHERE runId=r.id)
		AND NOT EXISTS(SELECT 1 FROM occupied WHERE owner=p.owner AND status='queued')
		AND (SELECT COUNT(*) FROM occupied) < ?`, r.Run, r.Slots)
	case "start":
		return exec(`UPDATE runs SET status='running',baseline=?,updatedAt=?
			WHERE id=? AND status='queued'
			AND NOT EXISTS (SELECT 1 FROM run_admission_drain)
			AND (SELECT COUNT(*) FROM runs WHERE status IN `+activeRuns+`) < ?`, r.Baseline, now, r.Run, r.Slots)
	case "acquire":
		_, err := db.ExecContext(ctx, `INSERT INTO run_slot_leases(slot,runId)
			SELECT n.slot,r.id FROM (SELECT 0 AS slot UNION ALL SELECT 1) n CROSS JOIN runs r
			WHERE r.id=? AND n.slot<? AND (r.status IN `+activeRuns+`
				OR (r.status='queued' AND NOT EXISTS(SELECT 1 FROM run_admission_drain)
					AND EXISTS(SELECT 1 FROM run_dispatches WHERE runId=r.id)))
			AND NOT EXISTS(SELECT 1 FROM run_slot_leases WHERE slot=n.slot OR runId=r.id)
			ORDER BY n.slot LIMIT 1`, r.Run, r.Slots)
		if err != nil {
			return nil, err
		}
		var slot int
		err = db.QueryRowContext(ctx, "SELECT slot FROM run_slot_leases WHERE runId=? AND slot<?", r.Run, r.Slots).Scan(&slot)
		if err == sql.ErrNoRows {
			return -1, nil
		}
		return slot, err
	case "release":
		return exec(releaseSlotSQL+" AND runId=?", r.Run)
	case "status":
		switch r.Status {
		case "queued", "running", "recovering", "cancelling", "succeeded", "failed", "cancelled", "needs_review":
		default:
			return nil, errAuthority
		}
		return exec("UPDATE runs SET status=?,summary=?,diff=?,updatedAt=? WHERE id=?", r.Status, r.Summary, r.Diff, now, r.Run)
	case "receipt":
		return exec("UPDATE runs SET receipt=1,updatedAt=? WHERE id=? AND status='running'", now, r.Run)
	case "reconcile":
		return exec("UPDATE runs SET reconciled=1,updatedAt=? WHERE id=? AND status='recovering'", now, r.Run)
	case "recovered":
		return exec("INSERT INTO run_recoveries VALUES (?,?)", r.Run, r.Generation)
	case "approve-run", "reject-run":
		return decideRunApproval(ctx, db, action, r, now)
	case "cancel-queued":
		return exec(`UPDATE runs SET status='cancelled',summary='Cancelled before start.',updatedAt=?
			WHERE id=? AND projectId=? AND status IN ('queued','pending_approval')`, now, r.Run, r.Project)
	case "request-cancel":
		return exec(`UPDATE runs SET status='cancelling',cancelGeneration=?,cancelWorkerClosed=?,
			summary='Cancellation requested.',updatedAt=?
			WHERE id=? AND projectId=? AND status='running' AND receipt=0`, r.Generation, r.Generation == 0, now, r.Run, r.Project)
	case "cancel-closed":
		return exec("UPDATE runs SET cancelWorkerClosed=1 WHERE id=? AND cancelGeneration=? AND status='cancelling'", r.Run, r.Generation)
	case "finish-cancel":
		if r.Status != "cancelled" && r.Status != "needs_review" {
			return nil, errAuthority
		}
		return exec(`UPDATE runs SET status=?,summary=?,updatedAt=?,diff=NULL
			WHERE id=? AND cancelGeneration=? AND status='cancelling' AND cancelWorkerClosed=1`,
			r.Status, r.Summary, now, r.Run, r.Generation)
	case "fail-baseline":
		return exec(`UPDATE runs SET status='failed',summary='Workspace baseline could not be captured.',updatedAt=?
			WHERE id=? AND status='queued'`, now, r.Run)
	case "complete-ambiguous", "drain":
		return consumeBusinessStop(ctx, db, action, r, now)
	case "enqueue", "accept-retry", "finalize-retry":
		return enqueueBusinessRun(ctx, db, action, r, now)
	case "publish-result", "confirm-review":
		return publishBusinessResult(ctx, db, action, r)
	default:
		return nil, errAuthority
	}
}

func decideRunApproval(ctx context.Context, db *sql.Conn, action string, r businessRequest, now string) (bool, error) {
	if r.Project == "" || r.Owner == "" {
		return false, errAuthority
	}
	status, summary := "queued", ""
	if action == "reject-run" {
		status, summary = "cancelled", "Run approval was denied."
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE runs SET status=?,summary=NULLIF(?,''),updatedAt=?
		WHERE id=? AND projectId=? AND status='pending_approval'
		AND EXISTS (SELECT 1 FROM projects WHERE id=runs.projectId AND owner=?)
		AND NOT EXISTS (SELECT 1 FROM draining_owners WHERE owner=?)`,
		status, summary, now, r.Run, r.Project, r.Owner, r.Owner)
	changed, err := reservation(result, err)
	if err != nil || changed != "reserved" {
		return false, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO run_approval_decisions(runId,action,decidedAt)
		VALUES (?,?,?)`, r.Run, action, now); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

func publishBusinessResult(ctx context.Context, db *sql.Conn, action string, r businessRequest) (bool, error) {
	if _, err := time.Parse(time.RFC3339Nano, r.CreatedAt); err != nil || r.Diff == nil {
		return false, errAuthority
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if action == "confirm-review" {
		if r.Proof == "" {
			return false, errAuthority
		}
		err = requireAuthorityChange(tx.ExecContext(ctx, `UPDATE runs SET status='succeeded',diff=?,updatedAt=?,
			summary='Workspace changes verified after recovery.'
			WHERE id=? AND status='needs_review' AND receipt=0
			AND EXISTS(SELECT 1 FROM run_recoveries WHERE runId=runs.id)`, r.Diff, r.CreatedAt, r.Run))
	} else {
		if !json.Valid([]byte(r.Body)) {
			return false, errAuthority
		}
		err = requireAuthorityChange(tx.ExecContext(ctx, `UPDATE runs SET status='succeeded',summary=?,diff=?,updatedAt=?
			WHERE id=? AND taskSequence IS NOT NULL AND status IN ('running','recovering','needs_review')
			AND (?='' OR (status='needs_review' AND receipt=0 AND
				EXISTS(SELECT 1 FROM run_recoveries WHERE runId=runs.id)))`, r.Summary, r.Diff, r.CreatedAt, r.Run, r.Proof))
		if err == nil {
			_, err = tx.ExecContext(ctx, "INSERT INTO task_run_results VALUES (?,?,?)", r.Run, r.Body, r.CreatedAt)
		}
	}
	if err != nil {
		return false, err
	}
	if r.Proof != "" {
		_, err = tx.ExecContext(ctx, "INSERT INTO run_reviews VALUES (?,?,?)", r.Run, r.Proof, r.CreatedAt)
		if err != nil {
			return false, err
		}
	}
	return true, tx.Commit()
}

func consumeBusinessStop(ctx context.Context, db *sql.Conn, action string, r businessRequest, now string) (bool, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if action == "drain" {
		var pending bool
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(
			SELECT 1 FROM runs WHERE status IN `+activeRuns+`
			UNION ALL SELECT 1 FROM run_slot_leases
			UNION ALL SELECT 1 FROM physical_stop_proofs p WHERE NOT EXISTS(
				SELECT 1 FROM physical_stop_consumption c WHERE c.runId=p.runId
				AND c.generation=p.generation AND c.consumer='slot' AND c.sha256=p.sha256))`).Scan(&pending)
		if err != nil || pending {
			return false, err
		}
		_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO physical_stop_consumption
			SELECT runId,generation,'upgrade',sha256 FROM physical_stop_consumption WHERE consumer='slot'`)
	} else {
		var canonical, digest string
		err = tx.QueryRowContext(ctx, "SELECT canonicalJson,sha256 FROM physical_stop_proofs WHERE runId=? AND generation=?", r.Run, r.Generation).Scan(&canonical, &digest)
		if err != nil {
			return false, err
		}
		expected := sha256.Sum256([]byte(canonical))
		if digest != hex.EncodeToString(expected[:]) {
			return false, errAuthority
		}
		_, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO physical_stop_consumption VALUES (?,?,'slot',?)", r.Run, r.Generation, digest)
		if err != nil {
			return false, err
		}
		err = requireAuthorityChange(tx.ExecContext(ctx, "UPDATE runs SET status='needs_review',summary=?,diff=NULL,updatedAt=? WHERE id=? AND status='recovering'", r.Summary, now, r.Run))
	}
	if err != nil {
		return false, err
	}
	return true, tx.Commit()
}

const queueCapacity = `((SELECT COUNT(*) FROM runs r JOIN projects p ON p.id=r.projectId
 WHERE p.owner=? AND r.status IN ('queued','pending_approval')) +
 (SELECT COUNT(*) FROM retry_attempts a JOIN tasks t ON t.id=a.taskId
 WHERE t.owner=? AND a.phase IN ('preparing','workspace_restored','history_restored','blocked'))) < ?`

func enqueueBusinessRun(ctx context.Context, db *sql.Conn, action string, r businessRequest, now string) (bool, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if action != "finalize-retry" && (r.QueueLimit < 1 || r.Owner == "" || r.Key == "") {
		return false, errAuthority
	}
	var result sql.Result
	var taskID, runID, eventID, body string
	switch action {
	case "enqueue":
		if (r.Task && !json.Valid([]byte(r.Body))) || (r.Task && r.Diagnostic) {
			return false, errAuthority
		}
		result, err = tx.ExecContext(ctx, `INSERT INTO runs
   (id,projectId,sessionId,key,prompt,status,createdAt,updatedAt,taskSequence)
   SELECT ?,p.id,?, ?,?,CASE WHEN ? THEN 'pending_approval' ELSE 'queued' END,?,?,CASE WHEN ? THEN
    (SELECT COALESCE(MAX(taskSequence),0)+1 FROM runs WHERE projectId=p.id) ELSE NULL END
   FROM projects p WHERE p.id=? AND p.owner=? AND p.status='ready'
   AND NOT EXISTS(SELECT 1 FROM runs WHERE projectId=p.id AND key=?)
   AND NOT EXISTS(SELECT 1 FROM runs WHERE projectId=p.id AND status IN ('pending_approval','queued','running','recovering','cancelling','needs_review'))
   AND NOT EXISTS(SELECT 1 FROM draining_owners WHERE owner=p.owner)
   AND (NOT ? OR EXISTS(SELECT 1 FROM tasks WHERE id=p.id AND owner=p.owner AND closedReason IS NULL))
   AND (NOT ? OR NOT EXISTS(SELECT 1 FROM retry_attempts WHERE taskId=p.id AND (key=? OR phase IN ('preparing','workspace_restored','history_restored','blocked'))))
   AND `+queueCapacity, r.Run, r.Session, r.Key, r.Prompt, r.Task && r.RequireApproval, now, now, r.Task, r.Project, r.Owner, r.Key, r.Task, r.Task, r.Key, r.Owner, r.Owner, r.QueueLimit)
		if r.Task {
			taskID, runID, eventID, body = r.Project, r.Run, r.Run+":user", r.Body
		}
	case "accept-retry":
		result, err = tx.ExecContext(ctx, `INSERT INTO retry_attempts
   SELECT ?,t.id,s.id,?,?,?,'preparing','preparing',?,?,?,?,NULL,?,?
   FROM tasks t JOIN runs s ON s.projectId=t.id JOIN projects p ON p.id=t.id
   WHERE t.id=? AND t.owner=? AND t.closedReason IS NULL AND p.status='ready'
   AND s.id=? AND s.status IN ('failed','cancelled') AND EXISTS(SELECT 1 FROM stop_proofs WHERE runId=s.id)
   AND NOT EXISTS(SELECT 1 FROM runs WHERE projectId=t.id AND (key=? OR taskSequence>s.taskSequence))
   AND NOT EXISTS(SELECT 1 FROM retry_attempts WHERE taskId=t.id AND (key=? OR sourceRunId=s.id OR phase IN ('preparing','workspace_restored','history_restored','blocked')))
   AND NOT EXISTS(SELECT 1 FROM draining_owners WHERE owner=t.owner)
   AND `+queueCapacity, r.Attempt, r.Run, r.Key, r.Proof, r.Generation, r.NewGeneration, r.WorkspaceSHA256, r.HistorySHA256, now, now, r.Project, r.Owner, r.SourceRun, r.Key, r.Key, r.Owner, r.Owner, r.QueueLimit)
	case "finalize-retry":
		if r.Status != "history_restored" && r.Status != "blocked" {
			return false, errAuthority
		}
		var phase string
		err = tx.QueryRowContext(ctx, "SELECT taskId,newRunId,phase FROM retry_attempts WHERE id=?", r.Run).Scan(&taskID, &runID, &phase)
		if err != nil {
			return false, err
		}
		if phase == "queued" {
			return true, nil
		}
		if phase != r.Status {
			return false, errAuthority
		}
		result, err = tx.ExecContext(ctx, `INSERT INTO runs
   (id,projectId,sessionId,key,prompt,status,createdAt,updatedAt,taskSequence,retryOf,expectedGeneration)
   SELECT a.newRunId,a.taskId,s.sessionId,a.key,s.prompt,'queued',?,?,
    (SELECT COALESCE(MAX(taskSequence),0)+1 FROM runs WHERE projectId=a.taskId),s.id,a.newGeneration
   FROM retry_attempts a JOIN runs s ON s.id=a.sourceRunId
   WHERE a.id=? AND a.phase=?`, now, now, r.Run, r.Status)
		eventID, body = runID+":retry", `{"kind":"step","text":"Retry queued.","check":null}`
	default:
		return false, errAuthority
	}
	reserved, err := reservation(result, err)
	if err != nil || reserved == "" {
		return false, err
	}
	if action == "enqueue" && r.Diagnostic {
		if _, err := tx.ExecContext(ctx, "INSERT INTO admin_diagnostic_runs(runId) VALUES (?)", r.Run); err != nil {
			return false, err
		}
	}
	if eventID != "" {
		_, err = tx.ExecContext(ctx, `INSERT INTO task_events
   SELECT ?,COALESCE(MAX(sequence),0)+1,?,?,?,? FROM task_events WHERE taskId=?`, taskID, eventID, runID, now, body, taskID)
		if err != nil {
			return false, err
		}
	}
	if action == "finalize-retry" {
		err = requireAuthorityChange(tx.ExecContext(ctx, `UPDATE retry_attempts SET phase='queued',lastConfirmedPhase='history_restored',error=NULL,updatedAt=? WHERE id=? AND phase=?`, now, r.Run, r.Status))
		if err != nil {
			return false, err
		}
	}
	return true, tx.Commit()
}
