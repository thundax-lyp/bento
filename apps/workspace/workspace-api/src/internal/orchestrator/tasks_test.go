package orchestrator

import (
	"encoding/json"
	"testing"
)

func TestGoTaskProjectsAndBindsUpstreamRun(t *testing.T) {
	const task = "00000000-0000-4000-8000-000000000001"
	const run = "00000000-0000-4000-8000-000000000002"
	const timestamp = "2026-11-27T00:00:00Z"
	body := map[string]any{
		"id": run, "taskId": task, "sequence": 1, "prompt": "work", "status": "queued",
		"retryOf": nil, "canContinue": false, "canCancel": true,
		"retryReason": nil, "resultVersion": nil, "summary": nil, "createdAt": timestamp, "updatedAt": timestamp,
		"privateWorkerData": "not public",
	}
	op := TaskRequest{Action: "run", Task: task, Run: run}
	raw, err := json.Marshal(map[string]any{"run": body})
	if err != nil {
		t.Fatal(err)
	}
	result, err := op.projectResponse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if projected := result.(map[string]any)["run"].(map[string]any); len(projected) != len(body)-1 || projected["privateWorkerData"] != nil {
		t.Fatalf("unexpected projection: %#v", projected)
	}
	op.Task = "wrong-task"
	if _, err := op.projectResponse(raw); err == nil {
		t.Fatal("expected an owner route binding mismatch to be rejected")
	}
}
