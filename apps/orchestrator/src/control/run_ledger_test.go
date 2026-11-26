package main

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/thundax-lyp/bento/apps/orchestrator/src/ledger"
)

func TestGoLedgerDispatchRetainsReservationWhenPublishUnconfirmed(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "runs.sqlite")
	l, err := ledger.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	b := ledger.Binding{Owner: "owner", Workspace: "workspace", Session: "session", Sandbox: "sandbox", Volume: "volume"}
	if _, err := l.Submit(ctx, "run", b, "inspect"); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Submit(ctx, "other", b, "inspect"); err != nil {
		t.Fatal(err)
	}
	type observation struct{ workflowID string }
	var calls []observation
	publish := func(_ context.Context, id string) error {
		calls = append(calls, observation{id})
		if len(calls) == 1 {
			return context.DeadlineExceeded
		}
		return nil
	}
	if _, err := publishLedgerDispatch(ctx, l, "run", publish); !errors.Is(err, errDispatchUnconfirmed) {
		t.Fatalf("first publish: %v", err)
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	l, err = ledger.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if _, err := publishLedgerDispatch(ctx, l, "other", publish); !errors.Is(err, ledger.ErrSlotBusy) {
		t.Fatalf("competing publish: %v", err)
	}
	id, err := publishLedgerDispatch(ctx, l, "run", publish)
	if err != nil || id != "bento-run-run" {
		t.Fatalf("retry publish: %s %v", id, err)
	}
	if len(calls) != 2 || calls[0].workflowID != id || calls[1].workflowID != id {
		t.Fatalf("workflow IDs: %+v", calls)
	}
}
