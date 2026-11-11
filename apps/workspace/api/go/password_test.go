package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
)

func TestPasswordAuthMySQL(t *testing.T) {
	host := os.Getenv("BENTO_MYSQL_HOST")
	if host == "" {
		t.Skip("set BENTO_MYSQL_HOST and the test MySQL account configuration")
	}
	cfg := mysql.NewConfig()
	cfg.Net, cfg.Addr = "tcp", host
	cfg.User, cfg.Passwd = os.Getenv("BENTO_MYSQL_USER"), os.Getenv("BENTO_MYSQL_PASSWORD")
	cfg.DBName = os.Getenv("BENTO_MYSQL_DATABASE")
	cfg.Timeout, cfg.ReadTimeout, cfg.WriteTimeout = 3*time.Second, 5*time.Second, 5*time.Second
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		t.Fatal(err)
	}
	db := sql.OpenDB(connector)
	t.Cleanup(func() { _ = db.Close() })
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	if err := initializeAccounts(ctx, db, ""); err != nil {
		t.Fatal(err)
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		t.Fatal(err)
	}
	owner := hex.EncodeToString(id[:])
	name := "integration-" + owner
	invite := "temporary-" + owner
	digest := sha256.Sum256([]byte(invite))
	_, err = db.ExecContext(ctx, "INSERT INTO web_accounts (owner_id, account, invite_hash) VALUES (?, ?, ?)",
		owner, name, hex.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := db.ExecContext(ctx, "DELETE FROM web_accounts WHERE owner_id = ?", owner); err != nil {
			t.Errorf("clean up fixture: %v", err)
		}
	})
	store := accounts{db: db}
	const origin = "https://workspace.example.invalid"
	handler := func() *http.ServeMux {
		mux := http.NewServeMux()
		newPasswordAuth(store, newWebSessions(store, true, false), origin, true).routes(mux)
		return mux
	}
	mux := handler()
	request := func(method, path, requestOrigin, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, origin+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", requestOrigin)
		for _, cookie := range cookies {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	expect := func(w *httptest.ResponseRecorder, code int, detail string) {
		t.Helper()
		if w.Code != code || !strings.Contains(w.Body.String(), detail) {
			t.Fatalf("got HTTP %d %s, want %d containing %q", w.Code, w.Body.String(), code, detail)
		}
	}

	body := func(values map[string]any) string {
		t.Helper()
		raw, err := json.Marshal(values)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	pass := "verification-" + owner
	loginJSON := body(map[string]any{"account": name, "password": pass})
	registerJSON := body(map[string]any{"account": name, "password": pass, "invite": invite})
	expect(request("POST", "/api/register", "https://foreign.example.invalid", registerJSON), 400, "invalid_origin")
	expect(request("POST", "/api/register", origin, registerJSON), 201, name)
	expect(request("POST", "/api/register", origin, registerJSON), 409, "already_registered")
	login := func() *http.Cookie {
		t.Helper()
		w := request("POST", "/api/login", origin, loginJSON)
		expect(w, 200, name)
		cookies := w.Result().Cookies()
		if len(cookies) != 1 || cookies[0].Name != "__Host-bento_one" ||
			!cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
			t.Fatal("unexpected session cookie")
		}
		return cookies[0]
	}

	first := login()
	expect(request("GET", "/api/session", origin, "", first), 200, name)
	expect(request("GET", "/api/session", origin, "", first, first), 401, "login_required")
	expect(request("POST", "/api/logout", origin, "", first), 200, "{}")
	expect(request("GET", "/api/session", origin, "", first), 401, "login_required")
	first = login()

	mux = handler()
	expect(request("GET", "/api/session", origin, "", first), 401, "login_required")
	first, second := login(), login()
	expect(request("POST", "/api/account/close", origin, body(map[string]any{"password": pass}), first), 400, "confirmation_required")
	expect(request("POST", "/api/account/close", origin, body(map[string]any{"password": pass, "confirmed": true}), first), 200, "{}")
	expect(request("GET", "/api/session", origin, "", second), 401, "login_required")
	expect(request("POST", "/api/login", origin, loginJSON), 401, "invalid_credentials")
	purges, err := store.pendingPurges(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range purges {
		if p.Owner == owner && p.Space {
			return
		}
	}
	t.Fatal("durable resource cleanup request was not recorded")
}
