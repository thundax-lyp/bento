package main

import (
	"context"
	"encoding/json"
	"errors"
	"go.temporal.io/sdk/activity"
	"sync/atomic"
	"testing"
	"time"

	"go.temporal.io/sdk/testsuite"
)

func TestDispatchHonorsCapacityAndTenantFIFO(t *testing.T) {
	tests := []struct {
		name, input, want string
	}{
		{"idle tenant first", `{"slots":2,"occupied":[{"owner":"A","status":"running"}],"queued":[{"id":"a1","owner":"A"},{"id":"b0","owner":"B"},{"id":"c0","owner":"C"}]}`, "b0"},
		{"same tenant can fill pool", `{"slots":2,"occupied":[{"owner":"A","status":"running"}],"queued":[{"id":"a1","owner":"A"},{"id":"a2","owner":"A"}]}`, "a1"},
		{"reserved tenant waits for admission", `{"slots":2,"occupied":[{"owner":"A","status":"queued"}],"queued":[{"id":"a1","owner":"A"},{"id":"b0","owner":"B"}]}`, "b0"},
		{"full pool counts recovery", `{"slots":2,"occupied":[{"owner":"A","status":"recovering"},{"owner":"B","status":"queued"}],"queued":[{"id":"c0","owner":"C"}]}`, ""},
		{"global FIFO when idle", `{"slots":2,"occupied":[],"queued":[{"id":"b0","owner":"B"},{"id":"a0","owner":"A"}]}`, "b0"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var snapshot dispatchSnapshot
			if err := json.Unmarshal([]byte(tt.input), &snapshot); err != nil {
				t.Fatal(err)
			}
			if got := chooseRun(snapshot); got != tt.want {
				t.Fatalf("selected %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRunWorkflowRetriesOnlyAdvancement(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	// The Activity only receives the stable Run ID. Prompt and execution grants
	// remain inside the fenced execution host when Temporal retries.
	var attempts atomic.Int32
	env.RegisterActivityWithOptions(func(_ context.Context, id string) error {
		if id != "run-1" {
			return errors.New("unexpected Run ID")
		}
		if attempts.Add(1) == 1 {
			return errors.New("host unavailable")
		}
		return nil
	}, activity.RegisterOptions{Name: "advanceRun"})
	env.SetTestTimeout(5 * time.Second)
	env.ExecuteWorkflow(bentoRun, "run-1")
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	if got := attempts.Load(); got != 2 {
		t.Fatalf("received %d Activity attempts, want 2", got)
	}
}
