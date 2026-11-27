package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-sql-driver/mysql"
)

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	mux := http.NewServeMux()
	var database *sql.DB
	done := make(chan error, 2)
	proxy := httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: "127.0.0.1:4101"})
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "Bento API unavailable", http.StatusBadGateway)
	}
	mux.Handle("/api/", proxy)
	mux.Handle("/auth", proxy)
	mux.Handle("/auth/", proxy)

	if host := os.Getenv("BENTO_MYSQL_HOST"); host != "" {
		cfg := mysql.NewConfig()
		cfg.Net = "tcp"
		cfg.Addr = host
		cfg.User = os.Getenv("BENTO_MYSQL_USER")
		cfg.Passwd = os.Getenv("BENTO_MYSQL_PASSWORD")
		cfg.DBName = os.Getenv("BENTO_MYSQL_DATABASE")
		cfg.Timeout, cfg.ReadTimeout, cfg.WriteTimeout = 3*time.Second, 5*time.Second, 5*time.Second
		if cfg.User == "" || cfg.Passwd == "" || cfg.DBName == "" {
			return errors.New("incomplete MySQL account configuration")
		}
		connector, err := mysql.NewConnector(cfg)
		if err != nil {
			return errors.New("invalid MySQL account configuration")
		}
		db := sql.OpenDB(connector)
		database = db
		defer db.Close()
		db.SetMaxOpenConns(8)
		startup, cancel := context.WithTimeout(ctx, 30*time.Second)
		err = initializeAccounts(startup, db, os.Getenv("BENTO_ONE_ACCOUNTS_FILE"))
		cancel()
		if err != nil {
			return errors.New("could not initialize MySQL accounts; check connectivity, schema and invitation file")
		}
		internalMux := http.NewServeMux()
		store := accounts{db: db}
		store.register(internalMux)
		if os.Getenv("BENTO_GO_AUTH") == "1" {
			if err := registerGoAuth(ctx, mux, internalMux, store); err != nil {
				return err
			}
		}
		internal := &http.Server{Handler: internalMux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second}
		listener, err := net.Listen("tcp", "127.0.0.1:4103")
		if err != nil {
			return err
		}
		defer internal.Close()
		go func() { done <- internal.Serve(listener) }()
	}

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if database != nil {
			probe, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			if err := database.PingContext(probe); err != nil {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
		}
		w.WriteHeader(http.StatusNoContent)
	})

	server := &http.Server{
		Addr: "127.0.0.1:4102", Handler: mux,
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 35 * time.Second,
		IdleTimeout: 60 * time.Second,
	}
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

func registerGoAuth(ctx context.Context, public, internal *http.ServeMux, store accounts) error {
	origin := strings.TrimSuffix(os.Getenv("BENTO_ONE_ORIGIN"), "/")
	if origin == "" {
		origin = "http://127.0.0.1:4101"
	}
	publicURL, err := secureOIDCURL(origin, true)
	if err != nil || publicURL.Path != "" || publicURL.RawQuery != "" {
		return errors.New("invalid Workspace origin")
	}
	issuer := os.Getenv("BENTO_OIDC_ISSUER")
	if issuer == "" && os.Getenv("BENTO_AUTH_MODE") == "keycloak" {
		return errors.New("Keycloak issuer is required")
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
			spaceRequired: spaceRequired, assetsDir: "/app/apps/workspace/workspace-auth/dist",
			spaceOrigin: strings.TrimSuffix(os.Getenv("BENTO_SPACE_S3_ENDPOINT"), "/"),
		}, store, sessions)
		if err != nil {
			if errors.Is(err, errAuthArtifacts) {
				return errAuthArtifacts
			}
			return errors.New("could not initialize Workspace OIDC")
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
	internal.HandleFunc("GET /internal/session", func(w http.ResponseWriter, r *http.Request) {
		session, err := sessions.current(r)
		if err != nil {
			authFailure(w, err)
			return
		}
		authJSON(w, 200, map[string]string{"ownerId": session.Owner, "account": session.Name})
	})
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
