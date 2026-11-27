package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProjectCancellation(t *testing.T) {
	const origin = "http://127.0.0.1:8080"
	const route = "/api/projects/project/runs/run/cancel"
	const timestamp = "2026-11-27T00:00:00Z"
	identity := account{Owner: "fixture-owner", Name: "fixture@example.test"}
	sessions := newWebSessions(oidcTestAccountReader{account: identity}, false, false)
	cookie, err := sessions.start(httptest.NewRequest(http.MethodGet, origin+route, nil), identity)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name        string
		upstream    int
		runStatus   string
		wantStatus  int
		wantFailure string
	}{
		{"cancellation accepted", 200, "cancelling", 200, ""},
		{"new terminal state", 200, "cancelled", 200, ""},
		{"invalid backend status", 200, "running", 502, "backend_error"},
		{"existing run cannot be cancelled", 409, "", 409, "conflict"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v1/projects/project/runs/run/cancel" ||
					r.Header.Get("X-Bento-Owner-Id") != identity.Owner || r.Header.Get("Authorization") != "Bearer fixture-only" ||
					r.ContentLength != 0 {
					t.Error("unexpected upstream cancellation request")
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.upstream)
				if tc.upstream == http.StatusOK {
					_ = json.NewEncoder(w).Encode(runView{
						ID: "run", Project: "project", Session: "session", Status: tc.runStatus,
						CreatedAt: timestamp, UpdatedAt: timestamp,
					})
				}
			}))
			defer backend.Close()
			mux := http.NewServeMux()
			projectService{origin: backend.URL, bearer: "fixture-only", client: backend.Client()}.routes(mux, sessions, origin)
			req := httptest.NewRequest(http.MethodPost, origin+route, nil)
			req.Header.Set("Origin", origin)
			req.AddCookie(cookie)
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, req)
			if response.Code != tc.wantStatus {
				t.Fatalf("status %d, want %d: %s", response.Code, tc.wantStatus, response.Body)
			}
			if tc.wantFailure != "" {
				var result struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Error.Code != tc.wantFailure {
					t.Fatalf("unexpected error response: %s", response.Body)
				}
			}
		})
	}
}
