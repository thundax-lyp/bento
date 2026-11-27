package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	sdklog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

type message struct {
	ID     string          `json:"id"`
	Method string          `json:"method,omitempty"`
	Value  json.RawMessage `json:"value,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type bridge struct {
	writer    sync.Mutex
	mu        sync.Mutex
	pending   map[string]chan message
	sequence  atomic.Uint64
	heartbeat func(context.Context, []byte, ...interface{}) error
}

const heartbeatTimeout = 10 * time.Second
const heartbeatInterval = 2 * time.Second

func (b *bridge) send(m message) error {
	b.writer.Lock()
	defer b.writer.Unlock()
	return json.NewEncoder(os.Stdout).Encode(m)
}

func (b *bridge) advance(ctx context.Context, runID string) error {
	var heartbeatLost <-chan struct{}
	if b.heartbeat != nil {
		token := activity.GetInfo(ctx).TaskToken
		sent := time.Now()
		probe, cancel := context.WithTimeout(ctx, heartbeatInterval)
		err := b.heartbeat(probe, token)
		cancel()
		if err != nil {
			return err
		}
		monitor, stop := context.WithCancel(ctx)
		defer stop()
		lost := make(chan struct{})
		heartbeatLost = lost
		go func() {
			if b.watchHeartbeat(monitor, token, sent.Add(heartbeatTimeout)) {
				close(lost)
			}
		}()
	}
	id := fmt.Sprintf("go-%d", b.sequence.Add(1))
	ch := make(chan message, 1)
	b.mu.Lock()
	b.pending[id] = ch
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
	}()
	value, _ := json.Marshal(runID)
	if err := b.send(message{ID: id, Method: "advance", Value: value}); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		_ = b.send(message{ID: id, Method: "stopAdvance"})
		return ctx.Err()
	case <-heartbeatLost:
		_ = b.send(message{ID: id, Method: "stopAdvance"})
		return errors.New("Temporal heartbeat confirmation lost")
	case result := <-ch:
		if result.Error != "" {
			return errors.New("execution host could not advance Run")
		}
		return nil
	}
}

// Bound local execution even when Temporal cannot deliver the expired Activity's
// cancellation over the same broken connection that lost its heartbeats.
func (b *bridge) watchHeartbeat(ctx context.Context, token []byte, deadline time.Time) bool {
	for {
		timer := time.NewTimer(min(heartbeatInterval, time.Until(deadline)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return false
		case <-timer.C:
		}
		sent := time.Now()
		if !sent.Before(deadline) {
			return true
		}
		probe, cancel := context.WithTimeout(ctx, min(heartbeatInterval, deadline.Sub(sent)))
		err := b.heartbeat(probe, token)
		cancel()
		if err == nil {
			deadline = sent.Add(heartbeatTimeout)
		} else {
			var expired *serviceerror.NotFound
			if errors.As(err, &expired) || temporal.IsCanceledError(err) {
				return true
			}
		}
	}
}

func bentoRun(ctx workflow.Context, runID string) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 3 * time.Hour,
		HeartbeatTimeout:    heartbeatTimeout,
		RetryPolicy:         &temporal.RetryPolicy{MaximumInterval: 10 * time.Second},
	})
	return workflow.ExecuteActivity(ctx, "advanceRun", runID).Get(ctx, nil)
}

type temporalConfig struct {
	Address      string `json:"address"`
	Namespace    string `json:"namespace"`
	TaskQueue    string `json:"taskQueue"`
	Slots        int    `json:"slots"`
	BusinessPath string `json:"businessPath"`
}

func runTemporal() error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	read := func() (message, error) {
		var m message
		if scanner.Scan() {
			err := json.Unmarshal(scanner.Bytes(), &m)
			return m, err
		}
		if err := scanner.Err(); err != nil {
			return m, err
		}
		return m, io.EOF
	}
	init, err := read()
	if err != nil || init.Method != "start" {
		return errors.New("Temporal control configuration required")
	}
	var cfg temporalConfig
	if err := json.Unmarshal(init.Value, &cfg); err != nil {
		return err
	}
	if cfg.Address == "" || !regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`).MatchString(cfg.TaskQueue) || (cfg.Slots != 1 && cfg.Slots != 2) {
		return errors.New("invalid Temporal control configuration")
	}
	if cfg.Namespace == "" {
		cfg.Namespace = "default"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	db, conn, err := openDispatchLedger(ctx, cfg.BusinessPath)
	if err != nil {
		cancel()
		return err
	}
	defer db.Close()
	defer conn.Close()
	c, err := client.DialContext(ctx, client.Options{
		HostPort: cfg.Address, Namespace: cfg.Namespace,
		Logger: sdklog.NewStructuredLogger(slog.Default()),
	})
	cancel()
	if err != nil {
		return errors.New("Temporal connection unavailable")
	}
	defer c.Close()
	b := &bridge{pending: make(map[string]chan message), heartbeat: c.RecordActivityHeartbeat}
	w := worker.New(c, cfg.TaskQueue, worker.Options{
		MaxConcurrentActivityExecutionSize: cfg.Slots,
		OnFatalError: func(error) {
			_, _ = fmt.Fprintln(os.Stderr, "Temporal worker stopped unexpectedly")
			os.Exit(1)
		},
		WorkerStopTimeout: 5 * time.Second,
	})
	w.RegisterWorkflowWithOptions(bentoRun, workflow.RegisterOptions{Name: "bentoRun"})
	w.RegisterActivityWithOptions(b.advance, activity.RegisterOptions{Name: "advanceRun"})
	if err := w.Start(); err != nil {
		return err
	}
	var stopOnce sync.Once
	stopWorker := func() { stopOnce.Do(w.Stop) }
	defer stopWorker()
	if err := b.send(message{ID: init.ID, Value: json.RawMessage("null")}); err != nil {
		return err
	}
	dispatch := runDispatcher{db: conn, publisher: c, queue: cfg.TaskQueue, slots: cfg.Slots}
	stopDispatch := dispatch.start()
	var commands sync.WaitGroup
	defer commands.Wait()
	defer stopDispatch()
	for {
		m, err := read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if m.Method == "" {
			b.mu.Lock()
			ch := b.pending[m.ID]
			b.mu.Unlock()
			if ch != nil {
				ch <- m
			}
			continue
		}
		if m.Method == "close" {
			stopDispatch()
			commands.Wait()
			stopWorker()
			return b.send(message{ID: m.ID, Value: json.RawMessage("null")})
		}
		commands.Add(1)
		go func(m message) {
			defer commands.Done()
			dispatch.publication.Lock()
			value, err := temporalCommand(c, cfg.Namespace, m)
			dispatch.publication.Unlock()
			if err != nil {
				_ = b.send(message{ID: m.ID, Error: "Temporal control request failed"})
				return
			}
			data, _ := json.Marshal(value)
			_ = b.send(message{ID: m.ID, Value: data})
		}(m)
	}
}

func temporalCommand(c client.Client, namespace string, m message) (any, error) {
	if m.Method != "purge" {
		return nil, errors.New("unknown control request")
	}
	var runID string
	if err := json.Unmarshal(m.Value, &runID); err != nil || runID == "" {
		return nil, errors.New("invalid Run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	description, err := c.DescribeWorkflowExecution(ctx, workflowID(runID), "")
	var missing *serviceerror.NotFound
	if errors.As(err, &missing) {
		return true, nil
	}
	if err != nil {
		return nil, err
	}
	if description.WorkflowExecutionInfo.Status == enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING {
		return false, nil
	}
	_, err = c.WorkflowService().DeleteWorkflowExecution(ctx, &workflowservice.DeleteWorkflowExecutionRequest{
		Namespace: namespace, WorkflowExecution: description.WorkflowExecutionInfo.Execution,
	})
	return false, err
}

type workflowPublisher interface {
	ExecuteWorkflow(context.Context, client.StartWorkflowOptions, interface{}, ...interface{}) (client.WorkflowRun, error)
}

func publishRunWorkflow(ctx context.Context, publisher workflowPublisher, queue, workflowID, runID string) error {
	_, err := publisher.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID: workflowID, TaskQueue: queue,
		WorkflowIDReusePolicy: enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
	}, "bentoRun", runID)
	var duplicate *serviceerror.WorkflowExecutionAlreadyStarted
	if errors.As(err, &duplicate) {
		return nil
	}
	return err
}
