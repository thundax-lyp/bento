//go:build darwin || linux

package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestTemporalFairDispatchThroughExecutionEntry(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("", "bento-fair-entry-")
	if err != nil {
		t.Fatal(err)
	}
	const name = "execution entry enforces two-slot tenant fairness and queue backpressure"
	cmd := exec.Command("node", "--import", "../../register-paths.mjs",
		"--experimental-strip-types", "--test", "--test-reporter=tap",
		"--test-name-pattern=^"+name+"$", "execution-service/service.test.ts")
	cmd.Env = append(os.Environ(), "BENTO_TEST_FAIR_BINARY="+binary, "BENTO_TEST_FAIR_DIR="+dir)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Start(); err != nil {
		t.Fatal(errors.Join(err, os.RemoveAll(dir)))
	}
	pid := cmd.Process.Pid
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()

	timer := time.NewTimer(75 * time.Second)
	defer timer.Stop()
	var failure error
	reaped := false
	select {
	case failure = <-waited:
		reaped = true
	case <-timer.C:
		failure = errors.New("fair dispatch test exceeded 75 seconds")
	}
	if !errors.Is(syscall.Kill(-pid, 0), syscall.ESRCH) {
		failure = errors.Join(failure, errors.New("fair dispatch process group still exists"))
	}
	if failure != nil {
		if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			t.Fatalf("kill process group %d (preserved %s): %v", pid, dir, err)
		}
		deadline := time.Now().Add(5 * time.Second)
		if !reaped {
			select {
			case <-waited:
				reaped = true
			case <-time.After(time.Until(deadline)):
				t.Fatalf("process group %d did not exit (preserved %s): %v", pid, dir, failure)
			}
		}
		for !errors.Is(syscall.Kill(-pid, 0), syscall.ESRCH) {
			if time.Now().After(deadline) {
				t.Fatalf("process group %d still exists (preserved %s): %v\n%s", pid, dir, failure, output.String())
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	if err := os.RemoveAll(dir); err != nil {
		failure = errors.Join(failure, err)
	}
	if failure != nil {
		t.Fatalf("Node test failed: %v\n%s", failure, output.String())
	}
	for _, line := range strings.Split(output.String(), "\n") {
		if line == "ok 1 - "+name {
			return
		}
	}
	t.Fatalf("expected a passing TAP result for %q\n%s", name, output.String())
}
