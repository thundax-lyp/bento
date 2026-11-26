package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

var errAuthority = errors.New("execution authority denied")

type authorityRequest struct {
	Session            string
	Tenant             string
	Project            string
	Sandbox            string
	Volume             string
	Run                string
	Controller         string
	Generation         int64
	LeaseMs            int64
	TokenDigest        string
	OperationID        string
	InputDigest        string
	Outcome            string
	Operation          string
	Installed          bool
	Running            bool
	Stopped            bool
	ChannelsClosed     bool
	CredentialsRevoked bool
	WritesRevoked      bool
	Proof              string
}

func requireAuthorityChange(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errAuthority
	}
	return nil
}

func authorityCommand(db *sql.Conn, action, path string, r authorityRequest) (string, error) {
	ctx := context.Background()
	if r.Session == "" || r.Generation < 1 {
		return "", errAuthority
	}
	exec := func(query string, args ...any) (sql.Result, error) {
		return db.ExecContext(ctx, query, args...)
	}
	change := func(query string, args ...any) error {
		return requireAuthorityChange(exec(query, args...))
	}
	switch action {
	case "bind":
		if !r.Installed || r.Generation != 1 || r.Tenant == "" || r.Project == "" || r.Sandbox == "" || r.Volume == "" {
			return "", errAuthority
		}
		return "", change(`INSERT INTO execution_sessions
			(session,tenant,project,sandbox,volume,generation,state)
			SELECT ?,?,?,?,?,1,'READY'
			WHERE NOT EXISTS (SELECT 1 FROM execution_sessions WHERE volume=?)
			AND NOT EXISTS (SELECT 1 FROM volume_reclaims WHERE volume=?)
			AND NOT EXISTS (SELECT 1 FROM released_session_references WHERE session=?)`,
			r.Session, r.Tenant, r.Project, r.Sandbox, r.Volume, r.Volume, r.Volume, r.Session)
	case "admit":
		now := time.Now().UnixMilli()
		if r.Run == "" || r.LeaseMs <= 0 || r.LeaseMs > math.MaxInt64-now {
			return "", errAuthority
		}
		return admitExecution(ctx, db, path, r, now+r.LeaseMs)
	case "revoke":
		return "", change(`UPDATE execution_sessions SET state='DRAINING',capability=NULL
			WHERE session=? AND generation=? AND state IN ('RUNNING','READY')`, r.Session, r.Generation)
	case "reserve-stop":
		result, err := exec(`INSERT INTO management_stops(session,generation,sandbox,operation,dispatcher)
			SELECT session,generation,sandbox,?,? FROM execution_sessions
			WHERE session=? AND generation=? AND state='DRAINING'
			ON CONFLICT(session,generation) DO NOTHING`, r.Operation, r.Controller, r.Session, r.Generation)
		return reservation(result, err)
	case "claim-recovery":
		result, err := exec(`UPDATE management_stops SET recovery_owner=?
			WHERE session=? AND generation=? AND recovery_owner IS NULL
			AND EXISTS (SELECT 1 FROM execution_sessions s WHERE s.session=management_stops.session
				AND s.generation=management_stops.generation AND s.sandbox=management_stops.sandbox AND s.state='UNKNOWN')`,
			r.Controller, r.Session, r.Generation)
		return reservation(result, err)
	case "reserve-start":
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return "", err
		}
		defer tx.Rollback()
		result, err := tx.ExecContext(ctx, `INSERT INTO management_starts(session,generation,sandbox,operation,controller)
			SELECT s.session,s.generation+1,s.sandbox,?,? FROM execution_sessions s JOIN management_stops m
			ON m.session=s.session AND m.generation=s.generation AND m.sandbox=s.sandbox
			WHERE s.session=? AND s.generation=? AND s.state='STOPPED' AND m.recovery_owner=?
			ON CONFLICT(session,generation) DO NOTHING`, r.Operation, r.Controller, r.Session, r.Generation, r.Controller)
		reserved, err := reservation(result, err)
		if err != nil || reserved == "" {
			return "", err
		}
		err = requireAuthorityChange(tx.ExecContext(ctx, `UPDATE execution_sessions SET state='START_UNKNOWN'
			WHERE session=? AND generation=? AND state='STOPPED'`, r.Session, r.Generation))
		if err != nil {
			return "", err
		}
		return reserved, tx.Commit()
	case "reserve-operation":
		if r.OperationID == "" || len(r.TokenDigest) != 64 || len(r.InputDigest) != 64 {
			return "", errAuthority
		}
		result, err := exec(`INSERT INTO operations(session,generation,id,digest,state)
			SELECT session,generation,?,?,'UNKNOWN' FROM execution_sessions
			WHERE session=? AND generation=? AND capability=? AND state='RUNNING' AND expires>?
			ON CONFLICT(session,id) DO NOTHING`,
			r.OperationID, r.InputDigest, r.Session, r.Generation, r.TokenDigest, time.Now().UnixMilli())
		return reservation(result, err)
	case "observe-operation":
		if r.Outcome != "SUCCEEDED" && r.Outcome != "FAILED" {
			return "", errAuthority
		}
		return "", change(`UPDATE operations SET state=?
			WHERE session=? AND generation=? AND id=? AND state='UNKNOWN'`,
			r.Outcome, r.Session, r.Generation, r.OperationID)
	case "stop-observation":
		state := "UNKNOWN"
		if r.Stopped && r.ChannelsClosed && r.CredentialsRevoked && r.WritesRevoked {
			state = "STOPPED"
		}
		if r.Controller == "" {
			return "", change(`UPDATE execution_sessions SET state=?
				WHERE session=? AND generation=? AND sandbox=? AND capability IS NULL
				AND state IN ('DRAINING','UNKNOWN')`, state, r.Session, r.Generation, r.Sandbox)
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return "", err
		}
		defer tx.Rollback()
		err = requireAuthorityChange(tx.ExecContext(ctx, `UPDATE execution_sessions SET state=?
			WHERE session=? AND generation=? AND sandbox=? AND capability IS NULL
			AND state IN ('DRAINING','UNKNOWN')
			AND EXISTS (SELECT 1 FROM management_stops m WHERE m.session=execution_sessions.session
				AND m.generation=execution_sessions.generation AND m.sandbox=execution_sessions.sandbox
				AND (m.recovery_owner=? OR (m.recovery_owner IS NULL AND m.dispatcher=? AND execution_sessions.state='DRAINING')))`,
			state, r.Session, r.Generation, r.Sandbox, r.Controller, r.Controller))
		if err != nil {
			return "", err
		}
		if state == "STOPPED" {
			_, err = tx.ExecContext(ctx, `UPDATE management_stops SET recovery_owner=dispatcher WHERE session=?
				AND generation=? AND sandbox=? AND dispatcher=? AND recovery_owner IS NULL`,
				r.Session, r.Generation, r.Sandbox, r.Controller)
			if err != nil {
				return "", err
			}
		}
		return "", tx.Commit()
	case "publish-ready":
		if !r.Installed || (r.Controller != "" && !r.Running) || r.Generation == math.MaxInt64 {
			return "", errAuthority
		}
		if r.Controller == "" {
			return "", change(`UPDATE execution_sessions SET generation=generation+1,state='READY',run=NULL,expires=NULL
				WHERE session=? AND generation=? AND sandbox=? AND state='STOPPED' AND capability IS NULL`, r.Session, r.Generation, r.Sandbox)
		}
		return "", change(`UPDATE execution_sessions SET generation=generation+1,state='READY',run=NULL,expires=NULL
			WHERE session=? AND generation=? AND sandbox=? AND volume=? AND state='START_UNKNOWN' AND capability IS NULL
			AND EXISTS (SELECT 1 FROM management_stops WHERE session=? AND generation=? AND recovery_owner=?)
			AND EXISTS (SELECT 1 FROM management_starts WHERE session=? AND generation=? AND sandbox=? AND controller=?)`,
			r.Session, r.Generation, r.Sandbox, r.Volume, r.Session, r.Generation, r.Controller,
			r.Session, r.Generation+1, r.Sandbox, r.Controller)
	case "physical-proof":
		return "", recordPhysicalProof(db, path, r)
	default:
		return "", errAuthority
	}
}

func randBytes() []byte {
	b := make([]byte, 32)
	rand.Read(b)
	return b
}

func reservation(result sql.Result, err error) (string, error) {
	if err != nil {
		return "", err
	}
	count, err := result.RowsAffected()
	if count == 1 {
		return "reserved", err
	}
	return "", err
}

type physicalStopProof struct {
	RunID          string
	SessionID      string
	Generation     int64
	BindingDigest  string
	WorkerExitedAt string
	ObservedAt     time.Time
	SandboxStopped bool
	VolumeWriters  *int
	RestoreIdle    bool
	GrantRevoked   bool
}

func recordPhysicalProof(db *sql.Conn, path string, r authorityRequest) error {
	ctx := context.Background()
	var proof physicalStopProof
	if json.Unmarshal([]byte(r.Proof), &proof) != nil {
		return errAuthority
	}
	exitedAt, err := time.Parse(time.RFC3339Nano, proof.WorkerExitedAt)
	if err != nil || proof.RunID != r.Run || proof.SessionID != r.Session ||
		proof.Generation != r.Generation || !proof.SandboxStopped || !proof.RestoreIdle || !proof.GrantRevoked ||
		proof.VolumeWriters == nil || *proof.VolumeWriters != 0 ||
		proof.ObservedAt.Before(exitedAt) || proof.ObservedAt.After(time.Now()) {
		return errAuthority
	}
	if _, err := db.ExecContext(ctx, "ATTACH DATABASE ? AS business", filepath.Join(filepath.Dir(path), "business.sqlite")); err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(r.Proof))
	return requireAuthorityChange(db.ExecContext(ctx, `INSERT INTO business.physical_stop_proofs(runId,generation,canonicalJson,sha256)
		SELECT r.id,s.generation,?,? FROM main.execution_sessions s JOIN business.runs r
		  ON r.sessionId=s.session AND r.id=s.run
		JOIN business.worker_exit e ON e.runId=r.id AND e.generation=s.generation
		WHERE s.session=? AND s.generation=? AND s.state='STOPPED' AND s.capability IS NULL
		  AND r.id=? AND r.admittedGeneration=s.generation AND r.admittedBindingDigest=?
		  AND e.bindingDigest=r.admittedBindingDigest AND e.exitedAt=?`,
		r.Proof, hex.EncodeToString(digest[:]), r.Session, r.Generation, r.Run, proof.BindingDigest, proof.WorkerExitedAt))
}

func runAuthority(path, action string) error {
	ctx := context.Background()
	if !filepath.IsAbs(path) || filepath.Base(path) != "authority.sqlite" {
		return errAuthority
	}
	var req authorityRequest
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 65536))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return errAuthority
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errAuthority
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return errAuthority
	}
	defer db.Close()
	conn, err := db.Conn(ctx)
	if err != nil {
		return errAuthority
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL"); err != nil {
		return errAuthority
	}
	value, err := authorityCommand(conn, action, path, req)
	if err != nil {
		return errAuthority
	}
	return json.NewEncoder(os.Stdout).Encode(value)
}

func admitExecution(ctx context.Context, db *sql.Conn, path string, r authorityRequest, expires int64) (string, error) {
	if r.Generation > 1 {
		if _, err := db.ExecContext(ctx, "ATTACH DATABASE ? AS history", filepath.Join(filepath.Dir(path), "history.sqlite")); err != nil {
			return "", err
		}
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var busy bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM execution_sessions other
  WHERE other.volume=(SELECT volume FROM execution_sessions WHERE session=?) AND other.session<>?
  AND (other.run IS NOT NULL OR EXISTS(SELECT 1 FROM operations WHERE session=other.session AND state='UNKNOWN')))`, r.Session, r.Session).Scan(&busy)
	if err != nil {
		return "", err
	}
	if busy {
		return "volume_busy", nil
	}
	token := hex.EncodeToString(randBytes())
	digest := sha256.Sum256([]byte(token))
	err = requireAuthorityChange(tx.ExecContext(ctx, `UPDATE execution_sessions SET state='RUNNING',run=?,capability=?,expires=?
  WHERE session=? AND generation=? AND state='READY' AND retiring=0`, r.Run, hex.EncodeToString(digest[:]), expires, r.Session, r.Generation))
	if err != nil {
		return "", err
	}
	if r.Generation > 1 {
		result, err := tx.ExecContext(ctx, `UPDATE history.sessions SET epoch=?,owner=?
   WHERE id=? AND handle IS NULL AND ((epoch=? AND owner='bento:revoked') OR (epoch=? AND owner=?))`,
			r.Generation, r.Run, r.Session, r.Generation-1, r.Generation, r.Run)
		reserved, err := reservation(result, err)
		if err != nil {
			return "", err
		}
		if reserved == "" {
			var exists bool
			if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM history.sessions WHERE id=?)", r.Session).Scan(&exists); err != nil {
				return "", err
			}
			if exists {
				return "", errAuthority
			}
		}
	}
	return token, tx.Commit()
}
