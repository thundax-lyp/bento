package api

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGoTaskRouteContract(t *testing.T) {
	const (
		task = "00000000-0000-4000-8000-000000000001"
		run  = "00000000-0000-4000-8000-000000000002"
		key  = "00000000-0000-4000-8000-000000000003"
		base = "/api/tasks/" + task
	)
	for _, tc := range []struct {
		method, path, key, body, want, code string
	}{
		{"GET", "/api/tasks", "", "", "list", ""},
		{"GET", base + "/events?after=9007199254740991", "", "", "events", ""},
		{"GET", base + "/events?after=9007199254740992", "", "", "", "invalid_input"},
		{"GET", base + "/events?after=1&after=2", "", "", "", "invalid_input"},
		{"GET", base + "/runs/" + run + "/results/1/diff?view=cumulative&download=1", "", "", "diff", ""},
		{"GET", base + "/runs/" + run + "/results/1/diff?view=other", "", "", "", "invalid_input"},
		{"POST", base + "/runs", key, `{"prompt":" work "}`, "createRun", ""},
		{"POST", base + "/runs", key, `{"prompt":"work","extra":1}`, "", "invalid_input"},
		{"POST", base + "/runs/" + run + "/retry", "", "", "", "invalid_key"},
		{"POST", base + "/runs/" + run + "/cancel", "", "{}", "", "invalid_input"},
		{"GET", base + "/prepare", "", "", "", "not_found"},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			if tc.body != "" {
				r.Header.Set("Content-Type", "application/json")
			}
			if tc.key != "" {
				r.Header.Set("Idempotency-Key", tc.key)
			}
			op, err := parseGoTask(httptest.NewRecorder(), r)
			if tc.code != "" {
				if err == nil || err.Error() != tc.code {
					t.Fatalf("error %v, want %s", err, tc.code)
				}
				return
			}
			if err != nil || op.Action != tc.want {
				t.Fatalf("action %s, error %v", op.Action, err)
			}
			if op.Action == "createRun" && (op.Prompt != "work" || op.Key != key) {
				t.Fatalf("invalid submit request: %#v", op)
			}
		})
	}
}
