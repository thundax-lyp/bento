package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/go-sql-driver/mysql"
)

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	mux := http.NewServeMux()
	host := os.Getenv("BENTO_MYSQL_HOST")
	cfg := mysql.NewConfig()
	cfg.Net = "tcp"
	cfg.Addr = host
	cfg.User = os.Getenv("BENTO_MYSQL_USER")
	cfg.Passwd = os.Getenv("BENTO_MYSQL_PASSWORD")
	cfg.DBName = os.Getenv("BENTO_MYSQL_DATABASE")
	cfg.Timeout, cfg.ReadTimeout, cfg.WriteTimeout = 3*time.Second, 5*time.Second, 5*time.Second
	if host == "" || cfg.User == "" || cfg.Passwd == "" || cfg.DBName == "" {
		return errors.New("incomplete MySQL account configuration")
	}
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return errors.New("invalid MySQL account configuration")
	}
	database := sql.OpenDB(connector)
	defer database.Close()
	database.SetMaxOpenConns(8)
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	err = initializeAccounts(startup, database, os.Getenv("BENTO_ONE_ACCOUNTS_FILE"))
	cancel()
	if err != nil {
		return errors.New("could not initialize MySQL accounts; check connectivity, schema and invitation file")
	}

	store := accounts{db: database}
	backend, err := workspaceProjectBackend()
	if err != nil {
		return err
	}
	space, err := registerGoAuth(ctx, mux, store, backend)
	if err != nil {
		return err
	}
	if space != nil {
		defer space.db.Close()
		defer space.stopReconciliation()
	}
	stopSweep := (accountSweep{store: store, backend: backend, space: space}).start(ctx)
	defer stopSweep()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		probe, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := database.PingContext(probe); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	})

	server := &http.Server{
		Addr: "127.0.0.1:4102", Handler: mux,
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 35 * time.Second,
		IdleTimeout: 60 * time.Second,
	}
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 35*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
}

func registerGoAuth(ctx context.Context, public *http.ServeMux, store accounts, backend projectService) (*spaceReader, error) {
	var space *spaceReader
	origin := strings.TrimSuffix(os.Getenv("BENTO_ONE_ORIGIN"), "/")
	if origin == "" {
		origin = "http://127.0.0.1:4102"
	}
	publicURL, err := secureOIDCURL(origin, true)
	if err != nil || publicURL.Path != "" || publicURL.RawQuery != "" {
		return nil, errors.New("invalid Workspace origin")
	}
	issuer := os.Getenv("BENTO_OIDC_ISSUER")
	if issuer == "" && os.Getenv("BENTO_AUTH_MODE") == "keycloak" {
		return nil, errors.New("Keycloak issuer is required")
	}
	spaceRequired := os.Getenv("BENTO_SPACE_S3_ENDPOINT") != ""
	sessions := newWebSessions(store, publicURL.Scheme == "https", issuer != "")
	password := newPasswordAuth(store, sessions, origin, spaceRequired)
	if issuer == "" {
		password.routes(public)
	} else {
		identity, err := newKeycloak(ctx, oidcOptions{
			origin: origin, issuer: issuer, clientID: os.Getenv("BENTO_OIDC_CLIENT_ID"),
			clientSecret: os.Getenv("BENTO_OIDC_CLIENT_SECRET"), organization: os.Getenv("BENTO_OIDC_ORGANIZATION"),
			spaceRequired: spaceRequired, assetsDir: "apps/workspace/workspace-auth/dist",
			spaceOrigin: strings.TrimSuffix(os.Getenv("BENTO_SPACE_S3_ENDPOINT"), "/"),
		}, store, sessions)
		if err != nil {
			if errors.Is(err, errAuthArtifacts) {
				return nil, errAuthArtifacts
			}
			return nil, errors.New("could not initialize Workspace OIDC")
		}
		identity.routes(public)
		password.sessionRoutes(public)
		for _, path := range []string{"/api/login", "/api/register", "/api/account/close", "/api/oidc/"} {
			public.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" && (len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != origin) {
					authFailure(w, &requestFailure{400, "invalid_origin", "请从任务入口提交请求。"})
					return
				}
				authFailure(w, notFound)
			})
		}
	}
	backend.routes(public, sessions, origin)
	var snapshots *spaceSnapshots
	database, endpoint, bucket := os.Getenv("BENTO_SPACE_DB"), os.Getenv("BENTO_SPACE_S3_ENDPOINT"), os.Getenv("BENTO_SPACE_S3_BUCKET")
	if database != "" || endpoint != "" || bucket != "" {
		if database == "" || database == ":memory:" || endpoint == "" || bucket == "" {
			return nil, errors.New("incomplete space configuration")
		}
		endpointURL, err := secureOIDCURL(strings.TrimSuffix(endpoint, "/"), loopback(publicURL.Hostname()))
		if err != nil || endpointURL.Path != "" || endpointURL.RawQuery != "" ||
			(!loopback(publicURL.Hostname()) && endpointURL.Hostname() == publicURL.Hostname()) {
			return nil, errors.New("invalid Workspace object storage origin")
		}
		storage, err := newSpaceStorage(ctx, strings.TrimSuffix(endpoint, "/"), bucket, os.Getenv("AWS_REGION"))
		if err != nil {
			return nil, errors.New("could not initialize Workspace object storage")
		}
		db, err := openSpaceDB(database, "rwc")
		if err != nil {
			return nil, errors.New("could not initialize Workspace space reader")
		}
		if err := initializeSpace(ctx, db); err != nil {
			db.Close()
			return nil, errors.New("could not initialize Workspace space schema")
		}
		space = &spaceReader{db: db, storage: storage}

		space.routes(public, sessions, backend)
		snapshots = &spaceSnapshots{db: db, read: storage.read, backend: backend}
		locks := &spaceLocks{}
		space.locks = locks
		execution := spaceExecution{db: db, storage: storage, backend: backend, wake: make(chan struct{}, 1), locks: locks}
		execution.routes(public, sessions, origin)
		uploads := spaceUploads{db: db, storage: storage, now: time.Now}
		uploads.routes(public, sessions, backend, origin, locks)
		projectDeletion := spaceProjectDeletion{db: db, storage: storage, backend: backend, locks: locks}
		projectDeletion.routes(public, sessions, origin, snapshots)
		stopUploads := uploads.startReconciliation(ctx, locks, backend, func(ctx context.Context) {
			projectDeletion.reconcile(ctx, snapshots)
		})
		stopSnapshots := snapshots.startReconciliation(ctx)
		stopExecution := execution.start(ctx)
		space.stopReconciliation = func() {
			stopExecution()
			stopSnapshots()
			stopUploads()
		}
	}
	backend.taskRoutes(public, sessions, origin, snapshots)
	public.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		backend.responseHeaders(w)
		if r.Method == http.MethodPost && (len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != origin) {
			authFailure(w, &requestFailure{400, "invalid_origin", "请从任务入口提交请求。"})
			return
		}
		if _, err := sessions.current(r); err != nil {
			authFailure(w, err)
			return
		}
		authFailure(w, notFound)
	})
	public.HandleFunc("/auth/", func(w http.ResponseWriter, r *http.Request) { authFailure(w, notFound) })
	return space, nil
}

func workspaceProjectBackend() (projectService, error) {
	origin := strings.TrimSuffix(os.Getenv("BENTO_ONE_TWO_URL"), "/")
	upstream, err := url.Parse(origin)
	bearer := os.Getenv("BENTO_ONE_TWO_BEARER")
	if err != nil || upstream.Hostname() == "" || upstream.User != nil ||
		(upstream.Scheme != "http" && upstream.Scheme != "https") || upstream.Path != "" ||
		upstream.RawQuery != "" || upstream.ForceQuery || upstream.Fragment != "" ||
		bearer == "" || strings.ContainsFunc(bearer, func(r rune) bool {
		return (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9') && !strings.ContainsRune("._~+/=-", r)
	}) {
		return projectService{}, errors.New("missing or invalid execution service configuration")
	}
	timeout := 10000
	if raw := os.Getenv("BENTO_ONE_TWO_TIMEOUT_MS"); raw != "" {
		timeout, err = strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || timeout < 1 || timeout > 30000 {
			return projectService{}, errors.New("invalid BENTO_ONE_TWO_TIMEOUT_MS")
		}
	}
	return projectService{
		origin: origin, bearer: bearer,
		spaceOrigin: strings.TrimSuffix(os.Getenv("BENTO_SPACE_S3_ENDPOINT"), "/"),
		client: &http.Client{Timeout: time.Duration(timeout) * time.Millisecond, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}, nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
