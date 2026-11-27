package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/thundax-lyp/bento/apps/orchestrator/orchestrator-control/src/ledger"
	"go.temporal.io/sdk/client"
	"golang.org/x/sys/unix"
)

var errDispatchUnconfirmed = errors.New("workflow publication unconfirmed")

type ledgerTemporalTarget struct {
	Address, Namespace, TaskQueue string
}

type ledgerRequest struct {
	Temporal                            ledgerTemporalTarget
	ID, Method                          string
	RunID, AttemptID, Prompt, Reference string
	Owner, TaskID, Key                  string
	Task                                ledger.Task
	Generation                          int64
	Binding                             ledger.Binding
	Attempt                             ledger.Attempt
	Stops                               ledger.StopObservation
	Outcome                             ledger.Outcome
}

type ledgerResponse struct {
	ID    string `json:"id"`
	Value any    `json:"value,omitempty"`
	Error string `json:"error,omitempty"`
}

type startGrant struct {
	Attempt ledger.Attempt `json:"attempt"`
	Issued  bool           `json:"issued"`
}

// The parent process owns the pipes. The Go child owns the database connection.
func runLedger(ctx context.Context, path string, in io.Reader, out io.Writer) error {
	if path == "" {
		return errors.New("Run ledger path required")
	}
	lock, err := os.OpenFile(path+".controller.lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fmt.Errorf("claim Run ledger controller: %w", err)
	}
	l, err := ledger.Open(ctx, path)
	if err != nil {
		return err
	}
	defer l.Close()
	reader := bufio.NewScanner(in)
	reader.Buffer(make([]byte, 64*1024), 512*1024)
	writer := json.NewEncoder(out)
	for reader.Scan() {
		var request ledgerRequest
		if err := json.Unmarshal(reader.Bytes(), &request); err != nil || request.ID == "" {
			return errors.New("invalid ledger control frame")
		}
		value, err := ledgerCall(ctx, l, request)
		reply := ledgerResponse{ID: request.ID, Value: value}
		if err != nil {
			reply.Value = nil
			switch {
			case errors.Is(err, sql.ErrNoRows):
				reply.Error = "not_found"
			case errors.Is(err, ledger.ErrIdempotency):
				reply.Error = "idempotency_conflict"
			case errors.Is(err, ledger.ErrTransition):
				reply.Error = "transition_refused"
			case errors.Is(err, ledger.ErrStale):
				reply.Error = "stale_attempt"
			case errors.Is(err, errDispatchUnconfirmed):
				reply.Error = "dispatch_unconfirmed"
			case errors.Is(err, ledger.ErrSlotBusy):
				reply.Error = "slot_busy"
			default:
				return fmt.Errorf("ledger transactional failure: %w", err)
			}
		}
		if err := writer.Encode(reply); err != nil {
			return err
		}
	}
	return reader.Err()
}

func ledgerCall(ctx context.Context, l *ledger.Ledger, r ledgerRequest) (any, error) {
	switch r.Method {
	case "ready":
		return true, nil
	case "submit":
		return l.Submit(ctx, r.RunID, r.Binding, r.Prompt)
	case "submitTaskRun":
		return l.SubmitTaskRun(ctx, r.Task, r.RunID, r.Key, r.Prompt)
	case "task":
		return l.Task(ctx, r.Owner, r.TaskID)
	case "admitWorker":
		return nil, l.AdmitWorker(ctx, r.Attempt, r.Binding)
	case "run":
		return l.Run(ctx, r.RunID)
	case "attempt":
		return l.Attempt(ctx, r.RunID, r.Generation)
	case "publishDispatch":
		if r.Temporal.Address == "" || r.Temporal.TaskQueue == "" {
			return nil, ledger.ErrTransition
		}
		return publishLedgerDispatch(ctx, l, r.RunID, func(ctx context.Context, id string) error {
			c, err := client.DialContext(ctx, client.Options{
				HostPort: r.Temporal.Address, Namespace: r.Temporal.Namespace,
			})
			if err != nil {
				return err
			}
			defer c.Close()
			return publishRunWorkflow(ctx, c, r.Temporal.TaskQueue, id, r.RunID)
		})
	case "reserveDispatch":
		return l.ReserveDispatch(ctx, r.RunID)
	case "consumeStart":
		a, issued, err := l.ConsumeStart(ctx, r.RunID, r.AttemptID)
		return startGrant{Attempt: a, Issued: issued}, err
	case "markRunning":
		return nil, l.MarkRunning(ctx, r.Attempt)
	case "recordCompletion":
		return nil, l.RecordCompletion(ctx, r.Attempt, r.Reference)
	case "cancelQueued":
		return nil, l.CancelQueued(ctx, r.RunID)
	case "revoke":
		return nil, l.Revoke(ctx, r.Attempt)
	case "recordStop":
		return nil, l.RecordStop(ctx, r.Attempt, r.Stops)
	case "markUnknown":
		return nil, l.MarkUnknown(ctx, r.Attempt)
	case "resolve":
		return nil, l.Resolve(ctx, r.Attempt, r.Outcome)
	default:
		return nil, ledger.ErrTransition
	}
}

func publishLedgerDispatch(ctx context.Context, l *ledger.Ledger, runID string, publish func(context.Context, string) error) (string, error) {
	id, err := l.ReserveDispatch(ctx, runID)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := publish(ctx, id); err != nil {
		return "", errDispatchUnconfirmed
	}
	return id, nil
}
