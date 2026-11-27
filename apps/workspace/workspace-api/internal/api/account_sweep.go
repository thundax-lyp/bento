package api

import (
	"context"
	"time"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/auth"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/orchestrator"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/space"
)

type accountSweep struct {
	store   auth.Store
	backend orchestrator.Client
	space   *space.Service
}

func (s accountSweep) start(ctx context.Context) func() {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for ctx.Err() == nil {
			s.run(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { cancel(); <-done }
}

func (s accountSweep) run(ctx context.Context) {
	pending, err := s.store.PendingPurges(ctx)
	if err != nil {
		return
	}
	for _, row := range pending {
		if ctx.Err() != nil {
			return
		}
		if s.purge(ctx, row) {
			_ = s.store.FinishPurge(ctx, row.Owner)
		}
	}
}

func (s accountSweep) purge(ctx context.Context, row auth.Purge) bool {
	if s.space != nil {
		if err := s.space.FenceOwner(ctx, row.Owner); err != nil {
			return false
		}
	}
	if err := s.backend.DrainOwner(ctx, row.Owner); err != nil {
		return false
	}
	if s.space != nil && !s.space.DrainOwner(ctx, row.Owner) {
		return false
	}
	complete, err := s.backend.PurgeOwner(ctx, row.Owner)
	if err != nil || !complete {
		return false
	}
	if s.space == nil {
		return !row.Space
	}
	return s.space.PurgeOwner(ctx, row.Owner)
}
