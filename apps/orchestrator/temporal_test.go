package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	sdklog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/temporal"
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

func TestTemporalRetryAfterCompletedRun(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const name = "Temporal Activity retries a completed Run without repeating its effect"
	cmd := exec.CommandContext(ctx, "node", "--import", "../../register-paths.mjs",
		"--experimental-strip-types", "--test", "--test-reporter=tap",
		"--test-name-pattern=^"+name+"$", "execution-service/service.test.ts")
	cmd.Env = append(os.Environ(), "BENTO_TEST_TEMPORAL_BINARY="+binary)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Node test failed: %v\n%s", err, output)
	}
	for _, line := range strings.Split(string(output), "\n") {
		if line == "ok 1 - "+name {
			return
		}
	}
	t.Fatalf("expected a passing TAP result for %q\n%s", name, output)
}

func TestTemporalRetryControlProcess(t *testing.T) {
	if os.Getenv("BENTO_TEST_TEMPORAL_REPORT") == "" {
		return
	}
	if err := runTemporalRetryControlFixture(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

func runTemporalRetryControlFixture() error {
	b := &bridge{pending: make(map[string]chan message)}
	replies := make(chan string, 2)
	done := make(chan error, 1)
	received := make(map[string]bool, 2)
	reportPath := os.Getenv("BENTO_TEST_TEMPORAL_REPORT")
	started, enqueued := false, false
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var m message
		if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
			return err
		}
		reply := message{ID: m.ID, Value: json.RawMessage("null")}
		switch m.Method {
		case "start":
			if started {
				return errors.New("duplicate start")
			}
			started = true
		case "choose":
			var snapshot dispatchSnapshot
			if !started || json.Unmarshal(m.Value, &snapshot) != nil || snapshot.Slots < 1 || snapshot.Slots > 2 {
				return errors.New("invalid choose request")
			}
			reply.Value, _ = json.Marshal(chooseRun(snapshot))
		case "enqueue":
			var runID string
			if !started || enqueued || json.Unmarshal(m.Value, &runID) != nil || runID == "" {
				return errors.New("invalid or duplicate enqueue")
			}
			enqueued = true
			if err := b.send(reply); err != nil {
				return err
			}
			go func() {
				var suite testsuite.WorkflowTestSuite
				suite.SetLogger(sdklog.NewStructuredLogger(slog.New(slog.NewTextHandler(os.Stderr, nil))))
				env := suite.NewTestWorkflowEnvironment()
				env.RegisterActivityWithOptions(b.advance, activity.RegisterOptions{Name: "advanceRun"})
				env.SetTestTimeout(10 * time.Second)
				env.ExecuteWorkflow(bentoRun, runID)
				if err := env.GetWorkflowError(); err != nil {
					fmt.Fprintln(os.Stderr, err)
					done <- err
					return
				}
				if len(replies) != 2 {
					err := errors.New("expected two successful host replies")
					fmt.Fprintln(os.Stderr, err)
					done <- err
					return
				}
				report := struct {
					RunID    string   `json:"runId"`
					ReplyIDs []string `json:"replyIds"`
				}{runID, []string{<-replies, <-replies}}
				data, err := json.Marshal(report)
				if err == nil {
					err = os.WriteFile(reportPath+".tmp", data, 0o600)
				}
				if err == nil {
					err = os.Rename(reportPath+".tmp", reportPath)
				}
				if err != nil {
					fmt.Fprintln(os.Stderr, err)
				}
				done <- err
			}()
			continue
		case "":
			b.mu.Lock()
			pending := b.pending[m.ID]
			b.mu.Unlock()
			if pending == nil || received[m.ID] || len(received) == 2 || m.Error != "" || !bytes.Equal(m.Value, []byte("null")) {
				return fmt.Errorf("unexpected Activity reply %q", m.ID)
			}
			received[m.ID] = true
			replies <- m.ID
			if len(received) == 1 {
				m.Value = nil
				m.Error = "injected loss of success acknowledgment"
			}
			pending <- m
			continue
		case "close":
			if !enqueued {
				return errors.New("closed before enqueue")
			}
			if err := <-done; err != nil {
				return err
			}
			return b.send(reply)
		default:
			return fmt.Errorf("unexpected control request %q", m.Method)
		}
		if err := b.send(reply); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return errors.New("control input closed before shutdown")
}

func TestTemporalFairDispatchControlProcess(t *testing.T) {
	dir := os.Getenv("BENTO_TEST_FAIR_DIR")
	if dir == "" {
		t.Skip("only run by the execution entry test")
	}
	if err := runTemporalFairDispatchControl(dir); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

func runTemporalFairDispatchControl(dir string) error {
	b := &bridge{pending: make(map[string]chan message)}
	published := make(map[string]bool)
	replied := make(map[string]bool)
	runIDPattern := regexp.MustCompile(`^[a-f0-9-]{36}$`)
	var workflows sync.WaitGroup
	started := false
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var m message
		if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
			return err
		}
		if !started && m.Method != "start" {
			return errors.New("expected start")
		}
		reply := message{ID: m.ID, Value: json.RawMessage("null")}
		switch m.Method {
		case "start":
			var config struct {
				Address, Namespace, TaskQueue string
				Slots                         int
			}
			if started || json.Unmarshal(m.Value, &config) != nil ||
				config.Address != "fixture" || config.Namespace != "default" ||
				config.TaskQueue != "fair-dispatch" || config.Slots != 2 {
				return errors.New("invalid fair dispatch configuration")
			}
			started = true
		case "choose":
			var snapshot dispatchSnapshot
			if json.Unmarshal(m.Value, &snapshot) != nil || snapshot.Slots != 2 {
				return errors.New("invalid fair dispatch snapshot")
			}
			reply.Value, _ = json.Marshal(chooseRun(snapshot))
		case "enqueue":
			var runID string
			if json.Unmarshal(m.Value, &runID) != nil || !runIDPattern.MatchString(runID) || published[runID] {
				return errors.New("invalid or duplicate fair dispatch enqueue")
			}
			published[runID] = true
			if err := b.send(reply); err != nil {
				return err
			}
			workflows.Add(1)
			go func(runID string) {
				defer workflows.Done()
				if err := runFairDispatchWorkflow(b, dir, runID); err != nil {
					fmt.Fprintf(os.Stderr, "Run %s: %v\n", runID, err)
					os.Exit(1)
				}
			}(runID)
			continue
		case "":
			b.mu.Lock()
			pending := b.pending[m.ID]
			b.mu.Unlock()
			if pending == nil || replied[m.ID] || m.Error != "" || !bytes.Equal(m.Value, []byte("null")) {
				return fmt.Errorf("invalid fair dispatch Activity reply %q", m.ID)
			}
			replied[m.ID] = true
			pending <- m
			continue
		case "close":
			workflows.Wait()
			return b.send(reply)
		default:
			return fmt.Errorf("unexpected fair dispatch request %q", m.Method)
		}
		if err := b.send(reply); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return errors.New("fair dispatch input closed before shutdown")
}

func runFairDispatchWorkflow(b *bridge, dir, runID string) error {
	var suite testsuite.WorkflowTestSuite
	suite.SetLogger(sdklog.NewStructuredLogger(slog.New(slog.NewTextHandler(os.Stderr, nil))))
	env := suite.NewTestWorkflowEnvironment()
	env.SetTestTimeout(40 * time.Second)
	var attempts atomic.Int32
	env.RegisterActivityWithOptions(func(ctx context.Context, id string) error {
		if attempts.Add(1) != 1 || id != runID {
			return temporal.NewNonRetryableApplicationError("unexpected Activity attempt or Run ID", "FairDispatchFixture", nil)
		}
		return b.advance(ctx, id)
	}, activity.RegisterOptions{Name: "advanceRun"})
	env.ExecuteWorkflow(bentoRun, runID)
	if err := env.GetWorkflowError(); err != nil {
		return err
	}
	if attempts.Load() != 1 {
		return fmt.Errorf("received %d Activity attempts, want 1", attempts.Load())
	}
	marker := filepath.Join(dir, "done-"+runID)
	if err := os.WriteFile(marker+".tmp", nil, 0600); err != nil {
		return err
	}
	return os.Rename(marker+".tmp", marker)
}
