package space

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestSpaceLockOnlyOwnerCanRelease(t *testing.T) {
	var locks spaceLocks
	if !locks.acquire("file", "first") || !locks.acquire("file", "first") ||
		locks.acquire("file", "second") {
		t.Fatal("file lock must be exclusive and same-token acquisition idempotent")
	}
	locks.release("file", "second")
	if !locks.owns("file", "first") {
		t.Fatal("foreign token released the file lock")
	}
	locks.release("file", "first")
	var successes atomic.Int32
	var attempts sync.WaitGroup
	for _, token := range []string{"second", "third"} {
		attempts.Go(func() {
			if locks.acquire("file", token) {
				successes.Add(1)
			}
		})
	}
	attempts.Wait()
	if successes.Load() != 1 {
		t.Fatalf("expected exactly one contender, got %d", successes.Load())
	}
}
