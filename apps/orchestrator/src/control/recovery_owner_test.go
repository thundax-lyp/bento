package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestRecoveryOwnerConcurrentTransfer(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "owner.sqlite")
	initial := recoveryOwnerRequest{Method: "initialize", Deployment: "deployment", Target: "source"}
	if owner, err := changeRecoveryOwner(ctx, path, initial); err != nil || owner.Host != "source" || owner.Epoch != 1 {
		t.Fatalf("initialize: %+v, %v", owner, err)
	}

	transfer := recoveryOwnerRequest{
		Method: "transfer", Deployment: initial.Deployment, Source: initial.Target,
		Epoch: 1, Checkpoint: strings.Repeat("a", 64), Isolation: strings.Repeat("b", 64),
	}
	type result struct {
		request recoveryOwnerRequest
		owner   recoveryOwner
		err     error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for _, target := range []string{"first", "second"} {
		request := transfer
		request.Target = target
		go func() {
			<-start
			owner, err := changeRecoveryOwner(ctx, path, request)
			results <- result{request, owner, err}
		}()
	}
	close(start)
	first, second := <-results, <-results
	if (first.err == nil) == (second.err == nil) {
		t.Fatalf("expected one winner: %+v, %+v", first, second)
	}
	winner := first
	if first.err != nil {
		winner = second
	}
	if winner.owner.Host != winner.request.Target || winner.owner.Epoch != 2 {
		t.Fatalf("wrong owner: %+v", winner)
	}
	stored, err := changeRecoveryOwner(ctx, path, recoveryOwnerRequest{Method: "inspect", Deployment: initial.Deployment})
	if err != nil || stored != winner.owner {
		t.Fatalf("inspect: %+v, %v", stored, err)
	}
	replayed, err := changeRecoveryOwner(ctx, path, winner.request)
	if err != nil || replayed != winner.owner {
		t.Fatalf("retry: %+v, %v", replayed, err)
	}
	winner.request.Isolation = strings.Repeat("c", 64)
	if _, err := changeRecoveryOwner(ctx, path, winner.request); err == nil {
		t.Fatal("accepted a retry with different isolation evidence")
	}
}
