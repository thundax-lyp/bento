package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/auth"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/httpx"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/orchestrator"
)

func TestProjectCancellation(t *testing.T) {
	const origin = "http://127.0.0.1:8080"
	const route = "/api/projects/project/runs/run/cancel"
	const timestamp = "2026-11-27T00:00:00Z"
	identity := &auth.Session{Owner: "fixture-owner", Name: "fixture@example.test"}
	current := func(*http.Request) (*auth.Session, error) { return identity, nil }
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
					_ = json.NewEncoder(w).Encode(orchestrator.RunView{
						ID: "run", Project: "project", Session: "session", Status: tc.runStatus,
						CreatedAt: timestamp, UpdatedAt: timestamp,
					})
				}
			}))
			defer backend.Close()
			mux := http.NewServeMux()
			projectRoutes{orchestrator.NewClient(backend.URL, "fixture-only", backend.Client()), func(w http.ResponseWriter) { httpx.SecurityHeaders(w, "") }}.registerProjects(mux, current, origin)
			req := httptest.NewRequest(http.MethodPost, origin+route, nil)
			req.Header.Set("Origin", origin)

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

func TestProjectInputContract(t *testing.T) {
	for _, tc := range []struct {
		body, code string
	}{
		{`{"name":"project","files":[]}`, ""},
		{`{"name":"project","files":[{"path":"emoji.txt","text":"\ud83d\ude00"}]}`, ""},
		{`{"name":"project","files":[{"path":"replacement.txt","text":"\ufffd"}]}`, ""},
		{`{"name":"project","files":[{"path":"\ud800","text":""}]}`, "invalid_path"},
		{`{"name":"project","files":[{"path":"text.txt","text":"\ud800"}]}`, "invalid_file"},
		{`{"name":"project","files":[{"path":"dir","text":""},{"path":"dir/a","text":""}]}`, "path_conflict"},
		{`{"Name":"project","files":[]}`, "invalid_project"},
		{`{"name":"project","files":[null]}`, "invalid_input"},
		{`[1,2]`, "invalid_input"},
		{`{"name":`, "invalid_json"},
	} {
		t.Run(tc.body, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/projects", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json; charset=utf-8")
			fields, err := httpx.ReadJSON(httptest.NewRecorder(), req, orchestrator.MaxProjectRequest)
			if err == nil {
				_, err = parseProjectInput(fields)
			}
			if tc.code == "" && err != nil {
				t.Fatal(err)
			}
			if tc.code != "" && (err == nil || err.Error() != tc.code) {
				t.Fatalf("error %v, want %s", err, tc.code)
			}
		})
	}
}
