package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"
	sdklog "go.temporal.io/sdk/log"
	"google.golang.org/protobuf/encoding/protojson"
)

type Input struct {
	Count int    `json:"count"`
	RunID string `json:"runId"`
}
type Scheduled struct {
	EventID      string `json:"eventId"`
	ActivityType string `json:"activityType"`
	TaskQueue    string `json:"taskQueue"`
	Input        Input  `json:"input"`
}
type Started struct {
	EventID          string `json:"eventId"`
	ScheduledEventID string `json:"scheduledEventId"`
	Attempt          int32  `json:"attempt"`
}
type Completed struct {
	ScheduledEventID string `json:"scheduledEventId"`
	StartedEventID   string `json:"startedEventId"`
}
type Pending struct {
	ActivityID string `json:"activityId"`
	Attempt    int32  `json:"attempt"`
	Started    bool   `json:"started"`
}
type Evidence struct {
	Schema            int         `json:"schema"`
	WorkflowID        string      `json:"workflowId"`
	ExecutionRunID    string      `json:"executionRunId"`
	WorkflowType      string      `json:"workflowType"`
	TaskQueue         string      `json:"taskQueue"`
	Status            string      `json:"status"`
	WorkflowInput     Input       `json:"workflowInput"`
	WorkflowStarted   int         `json:"workflowStarted"`
	WorkflowCompleted int         `json:"workflowCompleted"`
	WorkflowFailed    int         `json:"workflowFailed"`
	Continuations     int         `json:"continuations"`
	Scheduled         []Scheduled `json:"scheduled"`
	Started           []Started   `json:"started"`
	Completed         []Completed `json:"completed"`
	Pending           []Pending   `json:"pending"`
	HistorySHA256     string      `json:"historySha256"`
}

func input(payloads *commonpb.Payloads) (Input, error) {
	if payloads == nil || len(payloads.Payloads) != 1 {
		return Input{}, errors.New("expected exactly one Run ID payload")
	}
	var id string
	if err := converter.GetDefaultDataConverter().FromPayloads(payloads, &id); err != nil {
		return Input{}, err
	}
	if id == "" {
		return Input{}, errors.New("empty Run ID payload")
	}
	return Input{Count: 1, RunID: id}, nil
}
func readEvidence(ctx context.Context, c client.Client, workflowID, executionID, historyPath string) (Evidence, error) {
	description, err := c.DescribeWorkflowExecution(ctx, workflowID, executionID)
	if err != nil {
		return Evidence{}, err
	}
	info := description.GetWorkflowExecutionInfo()
	if info == nil || info.GetExecution() == nil {
		return Evidence{}, errors.New("workflow execution missing")
	}
	evidence := Evidence{Schema: 1, WorkflowID: info.Execution.WorkflowId, ExecutionRunID: info.Execution.RunId, WorkflowType: info.GetType().GetName(), TaskQueue: info.TaskQueue, Status: "other", Scheduled: []Scheduled{}, Started: []Started{}, Completed: []Completed{}, Pending: []Pending{}}
	switch info.Status {
	case enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING:
		evidence.Status = "running"
	case enumspb.WORKFLOW_EXECUTION_STATUS_COMPLETED:
		evidence.Status = "completed"
	}
	for _, p := range description.PendingActivities {
		evidence.Pending = append(evidence.Pending, Pending{ActivityID: p.ActivityId, Attempt: p.Attempt, Started: p.State == enumspb.PENDING_ACTIVITY_STATE_STARTED})
	}
	iterator := c.GetWorkflowHistory(ctx, workflowID, evidence.ExecutionRunID, false, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	history := &historypb.History{}
	for iterator.HasNext() {
		event, err := iterator.Next()
		if err != nil {
			return Evidence{}, err
		}
		history.Events = append(history.Events, event)
		switch event.EventType {
		case enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED:
			evidence.WorkflowStarted++
			evidence.WorkflowInput, err = input(event.GetWorkflowExecutionStartedEventAttributes().GetInput())
			if err != nil {
				return Evidence{}, err
			}
		case enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED:
			evidence.WorkflowCompleted++
		case enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED, enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED, enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT, enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED:
			evidence.WorkflowFailed++
		case enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW:
			evidence.Continuations++
		case enumspb.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED:
			a := event.GetActivityTaskScheduledEventAttributes()
			value, err := input(a.GetInput())
			if err != nil {
				return Evidence{}, err
			}
			evidence.Scheduled = append(evidence.Scheduled, Scheduled{EventID: fmt.Sprint(event.EventId), ActivityType: a.GetActivityType().GetName(), TaskQueue: a.GetTaskQueue().GetName(), Input: value})
		case enumspb.EVENT_TYPE_ACTIVITY_TASK_STARTED:
			a := event.GetActivityTaskStartedEventAttributes()
			evidence.Started = append(evidence.Started, Started{EventID: fmt.Sprint(event.EventId), ScheduledEventID: fmt.Sprint(a.ScheduledEventId), Attempt: a.Attempt})
		case enumspb.EVENT_TYPE_ACTIVITY_TASK_COMPLETED:
			a := event.GetActivityTaskCompletedEventAttributes()
			evidence.Completed = append(evidence.Completed, Completed{ScheduledEventID: fmt.Sprint(a.ScheduledEventId), StartedEventID: fmt.Sprint(a.StartedEventId)})
		}
	}
	raw, err := protojson.Marshal(history)
	if err != nil {
		return Evidence{}, err
	}
	digest := sha256.Sum256(raw)
	evidence.HistorySHA256 = hex.EncodeToString(digest[:])
	if err := os.WriteFile(historyPath, raw, 0600); err != nil {
		return Evidence{}, err
	}
	return evidence, nil
}
func run() error {
	address := flag.String("address", "", "loopback server")
	namespace := flag.String("namespace", "", "dedicated namespace")
	workflowID := flag.String("workflow", "", "business Workflow ID")
	executionID := flag.String("execution", "", "Temporal execution Run ID")
	historyPath := flag.String("history-out", "", "private evidence output")
	flag.Parse()
	host, _, err := net.SplitHostPort(*address)
	if err != nil || host != "127.0.0.1" || !strings.HasPrefix(*namespace, "bento-a6-") || !strings.HasPrefix(*workflowID, "bento-run-") || !filepath.IsAbs(*historyPath) || flag.NArg() != 0 {
		return errors.New("invalid isolated evidence probe arguments")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	c, err := client.DialContext(ctx, client.Options{HostPort: *address, Namespace: *namespace, Logger: sdklog.NewStructuredLogger(slog.Default())})
	if err != nil {
		return err
	}
	defer c.Close()
	evidence, err := readEvidence(ctx, c, *workflowID, *executionID, *historyPath)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(evidence)
}
func main() {
	if err := run(); err != nil {
		var missing *serviceerror.NotFound
		if errors.As(err, &missing) {
			fmt.Fprintln(os.Stderr, "Temporal evidence probe failed: workflow_not_found")
		} else {
			fmt.Fprintln(os.Stderr, "Temporal evidence probe failed:", err)
		}
		os.Exit(1)
	}
}
