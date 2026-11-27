package space

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/auth"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/orchestrator"
)

type Config struct {
	Origin, Database, Endpoint, Bucket, Region string
}

func Open(ctx context.Context, mux *http.ServeMux, current func(*http.Request) (*auth.Session, error), headers func(http.ResponseWriter), backend orchestrator.Client, cfg Config) (*Service, error) {
	storage, err := newSpaceStorage(ctx, cfg.Endpoint, cfg.Bucket, cfg.Region)
	if err != nil {
		return nil, errors.New("could not initialize Workspace object storage")
	}
	db, err := openSpaceDB(cfg.Database, "rwc")
	if err != nil {
		return nil, errors.New("could not initialize Workspace space reader")
	}
	if err := initializeSpace(ctx, db); err != nil {
		db.Close()
		return nil, errors.New("could not initialize Workspace space schema")
	}
	service := &Service{db: db, storage: storage}

	service.routes(mux, current, headers)
	snapshots := &spaceSnapshots{db: db, read: storage.read, backend: backend}
	locks := &spaceLocks{}
	service.locks = locks
	service.snapshots = snapshots
	execution := spaceExecution{db: db, storage: storage, backend: backend, wake: make(chan struct{}, 1), locks: locks}
	execution.routes(mux, current, headers, cfg.Origin)
	uploads := spaceUploads{db: db, storage: storage, now: time.Now}
	uploads.routes(mux, current, headers, backend, cfg.Origin, locks)
	projectDeletion := spaceProjectDeletion{db: db, storage: storage, backend: backend, locks: locks}
	projectDeletion.routes(mux, current, headers, cfg.Origin, snapshots)
	stopUploads := uploads.startReconciliation(ctx, locks, backend, func(ctx context.Context) {
		projectDeletion.reconcile(ctx, snapshots)
	})
	stopSnapshots := snapshots.startReconciliation(ctx)
	stopExecution := execution.start(ctx)
	service.stopReconciliation = func() {
		stopExecution()
		stopSnapshots()
		stopUploads()
	}
	return service, nil
}

func (s *Service) Close() {
	s.stopReconciliation()
	_ = s.db.Close()
}

func (s *Service) CreateTask(w http.ResponseWriter, r *http.Request, owner, key, name string, source Selection) error {
	return s.snapshots.create(w, r, owner, key, name, source)
}

func (s *Service) FenceOwner(ctx context.Context, owner string) error {
	_, err := s.db.ExecContext(ctx, "INSERT OR IGNORE INTO space_draining_owners VALUES (?)", owner)
	return err
}
