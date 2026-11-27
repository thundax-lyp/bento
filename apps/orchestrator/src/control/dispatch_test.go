package main

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
)

func dispatchTestLedger(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "business.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`
		PRAGMA journal_mode=WAL;
		CREATE TABLE projects(id TEXT PRIMARY KEY, owner TEXT NOT NULL);
		CREATE TABLE runs(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), status TEXT NOT NULL);
		CREATE TABLE run_dispatches(runId TEXT PRIMARY KEY REFERENCES runs(id));
		CREATE TABLE run_slot_leases(slot INTEGER PRIMARY KEY, runId TEXT UNIQUE REFERENCES runs(id));
		CREATE TABLE run_admission_drain(id INTEGER PRIMARY KEY);
		INSERT INTO projects VALUES ('a','A'),('b','B'),('c','C');
	`); err != nil {
		t.Fatal(err)
	}
	return path
}

func testDispatchConn(t *testing.T, path string) *sql.Conn {
	t.Helper()
	db, conn, err := openDispatchLedger(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
		_ = db.Close()
	})
	return conn
}

func dispatchExec(t *testing.T, conn *sql.Conn, statement string) {
	t.Helper()
	if _, err := conn.ExecContext(context.Background(), statement); err != nil {
		t.Fatal(err)
	}
}

func expectReservation(t *testing.T, conn *sql.Conn, slots int, want string) {
	t.Helper()
	got, err := reserveNextDispatch(context.Background(), conn, slots)
	if err != nil || got != want {
		t.Fatalf("reservation %q, error %v, want %q", got, err, want)
	}
}

func TestDispatchHonorsCapacityAndTenantFIFO(t *testing.T) {
	conn := testDispatchConn(t, dispatchTestLedger(t))
	dispatchExec(t, conn, `INSERT INTO runs VALUES
		('a0','a','recovering'),('a1','a','queued'),('a2','a','queued'),
		('b0','b','queued'),('c0','c','queued')`)
	expectReservation(t, conn, 2, "b0")
	expectReservation(t, conn, 2, "")
	dispatchExec(t, conn, "UPDATE runs SET status='cancelled' WHERE id='b0'")
	expectReservation(t, conn, 2, "c0")
	dispatchExec(t, conn, "UPDATE runs SET status='succeeded' WHERE id='c0'")
	expectReservation(t, conn, 2, "a1")
	expectReservation(t, conn, 2, "")
	dispatchExec(t, conn, "UPDATE runs SET status='succeeded' WHERE id='a0'")
	expectReservation(t, conn, 2, "") // A still has a queued reservation.
	dispatchExec(t, conn, "UPDATE runs SET status='running' WHERE id='a1'")
	dispatchExec(t, conn, "INSERT INTO run_admission_drain VALUES (1)")
	expectReservation(t, conn, 2, "")
	dispatchExec(t, conn, "DELETE FROM run_admission_drain")
	expectReservation(t, conn, 2, "a2")
}

func TestDispatchCountsOutstandingSlotLease(t *testing.T) {
	conn := testDispatchConn(t, dispatchTestLedger(t))
	dispatchExec(t, conn, `INSERT INTO runs VALUES ('a0','a','cancelled'),('b0','b','queued');
		INSERT INTO run_slot_leases VALUES (0,'a0')`)
	expectReservation(t, conn, 1, "")
	dispatchExec(t, conn, "DELETE FROM run_slot_leases")
	expectReservation(t, conn, 1, "b0")
}

func dispatchCount(t *testing.T, conn *sql.Conn) int {
	t.Helper()
	var count int
	if err := conn.QueryRowContext(context.Background(), "SELECT count(*) FROM run_dispatches").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestDispatchConcurrentReservationIssuesOnce(t *testing.T) {
	path := dispatchTestLedger(t)
	first := testDispatchConn(t, path)
	second := testDispatchConn(t, path)
	dispatchExec(t, first, "INSERT INTO runs VALUES ('a0','a','queued')")
	type result struct {
		id  string
		err error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	for _, conn := range []*sql.Conn{first, second} {
		go func(conn *sql.Conn) {
			<-start
			id, err := reserveNextDispatch(context.Background(), conn, 2)
			results <- result{id, err}
		}(conn)
	}
	close(start)
	count := 0
	for i := 0; i < 2; i++ {
		result := <-results
		if result.err != nil || (result.id != "" && result.id != "a0") {
			t.Fatalf("unexpected reservation %+v", result)
		}
		if result.id != "" {
			count++
		}
	}
	if count != 1 || dispatchCount(t, first) != 1 {
		t.Fatal("expected one successful reservation and one persisted row")
	}
}

type dispatchStartRecorder struct {
	calls     []string
	accepted  map[string]bool
	dropReply bool
}

func (p *dispatchStartRecorder) ExecuteWorkflow(_ context.Context, opts client.StartWorkflowOptions, workflow interface{}, args ...interface{}) (client.WorkflowRun, error) {
	if opts.TaskQueue != "fixture" || opts.WorkflowIDReusePolicy != enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE ||
		workflow != "bentoRun" || !reflect.DeepEqual(args, []interface{}{"a0"}) {
		return nil, errors.New("invalid workflow start request")
	}
	p.calls = append(p.calls, opts.ID)
	if p.accepted[opts.ID] {
		return nil, &serviceerror.WorkflowExecutionAlreadyStarted{}
	}
	p.accepted[opts.ID] = true
	if p.dropReply {
		p.dropReply = false
		return nil, context.DeadlineExceeded
	}
	return nil, nil
}

func TestDispatchReservationExitFixture(t *testing.T) {
	path := os.Getenv("BENTO_TEST_DISPATCH_EXIT_PATH")
	if path == "" {
		t.Skip("only run by reservation recovery test")
	}
	_, conn, err := openDispatchLedger(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	expectReservation(t, conn, 1, "a0")
	// Leave the committed reservation on disk, without cleanup or a publisher.
	os.Exit(0)
}

func reserveInChild(t *testing.T, path string) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestDispatchReservationExitFixture$")
	cmd.Env = append(os.Environ(), "BENTO_TEST_DISPATCH_EXIT_PATH="+path)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("reservation process: %v\n%s", err, output)
	}
}

func TestDispatchRecoversAfterReservationProcessExit(t *testing.T) {
	path := dispatchTestLedger(t)
	conn := testDispatchConn(t, path)
	dispatchExec(t, conn, "INSERT INTO runs VALUES ('a0','a','queued')")
	reserveInChild(t, path)
	reopened := testDispatchConn(t, path)
	if dispatchCount(t, reopened) != 1 {
		t.Fatal("reservation did not survive process exit")
	}
	p := &dispatchStartRecorder{accepted: make(map[string]bool)}
	d := runDispatcher{db: reopened, publisher: p, queue: "fixture", slots: 1}
	if err := d.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(p.calls, []string{"bento-run-a0"}) || dispatchCount(t, reopened) != 1 {
		t.Fatalf("recovery changed the Workflow ID or reservation: %v", p.calls)
	}
}

func TestDispatchRetriesLostPublishReplyWithOriginalWorkflowID(t *testing.T) {
	path := dispatchTestLedger(t)
	conn := testDispatchConn(t, path)
	dispatchExec(t, conn, "INSERT INTO runs VALUES ('a0','a','queued')")
	p := &dispatchStartRecorder{dropReply: true, accepted: make(map[string]bool)}
	first := runDispatcher{db: conn, publisher: p, queue: "fixture", slots: 1}
	ctx := context.Background()
	if err := first.tick(ctx); !errors.Is(err, context.DeadlineExceeded) || dispatchCount(t, conn) != 1 {
		t.Fatalf("lost reply did not leave a durable reservation: %v", err)
	}
	reopened := testDispatchConn(t, path)
	next := runDispatcher{db: reopened, publisher: p, queue: "fixture", slots: 1}
	for i := 0; i < 2; i++ {
		if err := next.tick(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(p.calls, []string{"bento-run-a0", "bento-run-a0"}) || len(p.accepted) != 1 || dispatchCount(t, reopened) != 1 {
		t.Fatalf("expected two requests for one Workflow and one reservation: %v", p.calls)
	}
}

type lostTemporalStartReply struct {
	client.Client
	starts      []string
	executionID string
}

func (p *lostTemporalStartReply) ExecuteWorkflow(ctx context.Context, opts client.StartWorkflowOptions, workflow interface{}, args ...interface{}) (client.WorkflowRun, error) {
	p.starts = append(p.starts, opts.ID)
	run, err := p.Client.ExecuteWorkflow(ctx, opts, workflow, args...)
	if len(p.starts) == 1 && err == nil {
		p.executionID = run.GetRunID()
		return nil, context.DeadlineExceeded
	}
	return run, err
}

func TestDispatchPublishAgainstTemporal(t *testing.T) {
	address := os.Getenv("BENTO_TEST_DISPATCH_TEMPORAL_ADDRESS")
	namespace := os.Getenv("BENTO_TEST_DISPATCH_TEMPORAL_NAMESPACE")
	if address == "" || namespace == "" {
		t.Skip("requires the isolated Temporal acceptance server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c, err := client.DialContext(ctx, client.Options{HostPort: address, Namespace: namespace})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	path := dispatchTestLedger(t)
	seed := testDispatchConn(t, path)
	dispatchExec(t, seed, "INSERT INTO runs VALUES ('a0','a','queued')")
	reserveInChild(t, path)
	conn := testDispatchConn(t, path)
	if dispatchCount(t, conn) != 1 {
		t.Fatal("reservation did not survive process exit")
	}
	publisher := &lostTemporalStartReply{Client: c}
	first := runDispatcher{db: conn, publisher: publisher, queue: "dispatch-acceptance", slots: 1}
	if err := first.tick(ctx); !errors.Is(err, context.DeadlineExceeded) || publisher.executionID == "" {
		t.Fatalf("did not lose a successful Temporal start reply: %v", err)
	}
	reopened := testDispatchConn(t, path)
	restarted := runDispatcher{db: reopened, publisher: publisher, queue: "dispatch-acceptance", slots: 1}
	if err := restarted.tick(ctx); err != nil {
		t.Fatal(err)
	}
	id := workflowID("a0")
	description, err := c.DescribeWorkflowExecution(ctx, id, "")
	if err != nil {
		t.Fatal(err)
	}
	execution := description.GetWorkflowExecutionInfo().GetExecution()
	if !reflect.DeepEqual(publisher.starts, []string{id, id}) ||
		execution.GetWorkflowId() != id || execution.GetRunId() != publisher.executionID ||
		dispatchCount(t, reopened) != 1 {
		t.Fatalf("recovery changed the reservation or Temporal execution: %v, %v", publisher.starts, execution)
	}
}
