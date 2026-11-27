package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type oidcTestAccountReader struct {
	account account
}

func (f oidcTestAccountReader) accountByOwner(_ context.Context, _ string) (account, error) {
	return f.account, nil
}

func TestOIDCAuthPages(t *testing.T) {
	const origin = "http://127.0.0.1:8080"
	var issuer string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/openid-configuration" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"issuer": issuer, "authorization_endpoint": issuer + "/authorize",
			"token_endpoint": issuer + "/token", "jwks_uri": issuer + "/keys",
			"end_session_endpoint": issuer + "/logout",
		})
	}))
	defer provider.Close()
	issuer = provider.URL
	directory := t.TempDir()
	options := oidcOptions{
		origin: origin, issuer: issuer, clientID: "fixture", clientSecret: "fixture-only",
		organization: "fixture", assetsDir: directory,
	}
	identity := account{Owner: "fixture-owner", Name: "fixture@example.test"}
	sessions := newWebSessions(oidcTestAccountReader{account: identity}, false, true)
	if _, err := newKeycloak(t.Context(), options, nil, sessions); err == nil ||
		err.Error() != "Workspace auth build artifacts are unavailable" {
		t.Fatalf("missing artifacts: %v", err)
	}

	for name, body := range map[string]string{
		"login.html": "<html>login</html>", "account.html": "<html>account</html>", "style.css": "body{}",
	} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	auth, err := newKeycloak(t.Context(), options, nil, sessions)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	auth.routes(mux)
	signedIn, err := sessions.start(httptest.NewRequest(http.MethodGet, origin+"/auth", nil), identity)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path, contentType, body, referrer string
		cookie                            *http.Cookie
	}{
		{"/auth", "text/html; charset=utf-8", "<html>login</html>", "same-origin", nil},
		{"/auth", "text/html; charset=utf-8", "<html>account</html>", "same-origin", signedIn},
		{"/auth/style.css", "text/css; charset=utf-8", "body{}", "no-referrer", nil},
	} {
		t.Run(tc.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, origin+tc.path, nil)
			if tc.cookie != nil {
				request.AddCookie(tc.cookie)
			}
			mux.ServeHTTP(response, request)
			if response.Code != 200 || response.Body.String() != tc.body ||
				response.Header().Get("Content-Type") != tc.contentType ||
				response.Header().Get("Cache-Control") != "no-store" ||
				response.Header().Get("Referrer-Policy") != tc.referrer ||
				response.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("unexpected auth response: %d %#v %q", response.Code, response.Header(), response.Body)
			}
			if tc.path == "/auth" && !strings.HasSuffix(response.Header().Get("Content-Security-Policy"), "form-action 'self' "+issuer) {
				t.Fatal("login policy must allow the configured issuer")
			}
		})
	}
}
