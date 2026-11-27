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

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/api"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/auth"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/orchestrator"
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
	err = auth.InitializeAccounts(startup, database, os.Getenv("BENTO_ONE_ACCOUNTS_FILE"))
	cancel()
	if err != nil {
		return errors.New("could not initialize MySQL accounts; check connectivity, schema and invitation file")
	}

	store := auth.NewStore(database)
	backend, err := workspaceProjectBackend()
	if err != nil {
		return err
	}
	closeAPI, err := api.Register(ctx, mux, store, backend)
	if err != nil {
		return err
	}
	defer closeAPI()

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

func workspaceProjectBackend() (orchestrator.Client, error) {
	origin := strings.TrimSuffix(os.Getenv("BENTO_ONE_TWO_URL"), "/")
	upstream, err := url.Parse(origin)
	bearer := os.Getenv("BENTO_ONE_TWO_BEARER")
	if err != nil || upstream.Hostname() == "" || upstream.User != nil ||
		(upstream.Scheme != "http" && upstream.Scheme != "https") || upstream.Path != "" ||
		upstream.RawQuery != "" || upstream.ForceQuery || upstream.Fragment != "" ||
		bearer == "" || strings.ContainsFunc(bearer, func(r rune) bool {
		return (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9') && !strings.ContainsRune("._~+/=-", r)
	}) {
		return orchestrator.Client{}, errors.New("missing or invalid execution service configuration")
	}
	timeout := 10000
	if raw := os.Getenv("BENTO_ONE_TWO_TIMEOUT_MS"); raw != "" {
		timeout, err = strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || timeout < 1 || timeout > 30000 {
			return orchestrator.Client{}, errors.New("invalid BENTO_ONE_TWO_TIMEOUT_MS")
		}
	}
	return orchestrator.NewClient(origin, bearer,
		&http.Client{Timeout: time.Duration(timeout) * time.Millisecond, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}}), nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
