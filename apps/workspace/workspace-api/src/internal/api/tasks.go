package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/auth"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/httpx"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/orchestrator"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/space"
)

var (
	taskPath = regexp.MustCompile(`^/api/tasks/([^/]+)(?:/(prepare|events|runs)(?:/([^/]+)(?:/(cancel|retry|results)(?:/(1)/diff)?)?)?)?$`)
	taskSeq  = regexp.MustCompile(`^[0-9]+$`)

	badKey = httpx.NewError(400, "invalid_key", "提交键无效。")
)

func parseGoTask(w http.ResponseWriter, r *http.Request) (orchestrator.TaskRequest, error) {
	var result orchestrator.TaskRequest
	path := r.URL.EscapedPath()
	if path == "/api/tasks" && r.Method == http.MethodGet {
		result.Action = "list"
	} else {
		match := taskPath.FindStringSubmatch(path)
		if len(match) == 0 || !orchestrator.ValidTaskID(match[1]) ||
			(match[3] != "" && !orchestrator.ValidTaskID(match[3])) {
			return result, httpx.NotFound
		}
		result.Task, result.Run = match[1], match[3]
		section, mode, version := match[2], match[4], match[5]
		switch {
		case section == "" && r.Method == http.MethodGet:
			result.Action = "task"
		case section == "prepare" && result.Run == "" && r.Method == http.MethodPost:
			result.Action = "prepare"
		case section == "events" && result.Run == "" && r.Method == http.MethodGet:
			result.Action = "events"
		case section == "runs" && result.Run == "" && r.Method == http.MethodGet:
			result.Action = "listRuns"
		case section == "runs" && result.Run == "" && r.Method == http.MethodPost:
			result.Action = "createRun"
		case section == "runs" && result.Run != "" && mode == "" && r.Method == http.MethodGet:
			result.Action = "run"
		case section == "runs" && mode == "cancel" && version == "" && r.Method == http.MethodPost:
			result.Action = "cancel"
		case section == "runs" && mode == "retry" && version == "" && r.Method == http.MethodPost:
			result.Action = "retry"
		case section == "runs" && mode == "results" && r.Method == http.MethodGet:
			result.Action = "result"
			if version != "" {
				result.Action = "diff"
			}
		default:
			return result, httpx.NotFound
		}
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return result, httpx.InvalidTask
	}
	for key, values := range query {
		if len(values) != 1 ||
			!(result.Action == "events" && key == "after" || result.Action == "diff" && (key == "view" || key == "download")) {
			return result, httpx.InvalidTask
		}
	}
	if result.Action == "events" && query.Has("after") {
		after := query.Get("after")
		sequence, err := strconv.ParseUint(after, 10, 53)
		if !taskSeq.MatchString(after) || err != nil || sequence > 1<<53-1 {
			return result, httpx.InvalidTask
		}
	}
	if result.Action == "diff" {
		view := query.Get("view")
		if view != "incremental" && view != "cumulative" || query.Has("download") && query.Get("download") != "1" {
			return result, httpx.InvalidTask
		}
	}
	if result.Action == "createRun" || result.Action == "retry" {
		keys := r.Header.Values("Idempotency-Key")
		if len(keys) != 1 || !orchestrator.ValidTaskID(keys[0]) {
			return result, badKey
		}
		result.Key = keys[0]
	}
	if result.Action == "createRun" {
		fields, err := httpx.ReadJSON(w, r, 64*1024)
		if err != nil {
			var failure *httpx.Error
			if errors.As(err, &failure) && failure.Status == 400 {
				return result, httpx.InvalidTask
			}
			return result, err
		}
		if len(fields) != 1 {
			return result, httpx.InvalidTask
		}
		prompt, _ := httpx.String(fields["prompt"])
		result.Prompt = strings.TrimSpace(prompt)
		if result.Prompt == "" || utf8.RuneCountInString(result.Prompt) > 8000 {
			return result, httpx.NewError(400, "invalid_prompt", "任务描述须为 1 至 8000 个字符。")
		}
	} else if r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
		return result, httpx.NewError(400, "invalid_input", "此任务请求不接受正文。")
	}
	result.Path = "/v1" + strings.TrimPrefix(path, "/api")
	result.Query = query
	return result, nil
}

func (s projectRoutes) registerTasks(mux *http.ServeMux, current func(*http.Request) (*auth.Session, error), origin string, snapshots *space.Service) {
	handle := func(w http.ResponseWriter, r *http.Request) {
		s.headers(w)
		if r.Method == http.MethodPost && (len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != origin) {
			httpx.Fail(w, httpx.NewError(400, "invalid_origin", "请从任务入口提交请求。"))
			return
		}
		session, err := current(r)
		if err == nil {
			if r.Method == http.MethodPost && r.URL.EscapedPath() == "/api/tasks" {
				err = s.createTask(w, r, session.Owner, snapshots)
			} else {
				err = s.serveTask(w, r, session.Owner)
			}
		}
		if err != nil {
			httpx.Fail(w, err)
		}
	}
	mux.HandleFunc("GET /api/tasks", handle)
	mux.HandleFunc("POST /api/tasks", handle)
	mux.HandleFunc("GET /api/tasks/", handle)
	mux.HandleFunc("POST /api/tasks/", handle)
}

func (s projectRoutes) createTask(w http.ResponseWriter, r *http.Request, owner string, snapshots *space.Service) error {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query) != 0 {
		return httpx.InvalidTask
	}
	keys := r.Header.Values("Idempotency-Key")
	if len(keys) != 1 || !orchestrator.ValidTaskID(keys[0]) {
		return badKey
	}
	const limit = 64 * 1024
	media := strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0])
	if !strings.EqualFold(media, "application/json") {
		return httpx.InvalidTask
	}
	tooLarge := httpx.NewError(413, "too_large", "请求超过大小限制。")
	if r.ContentLength > limit {
		return tooLarge
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	var sizeError *http.MaxBytesError
	if errors.As(err, &sizeError) {
		return tooLarge
	}
	if err != nil || !utf8.Valid(raw) {
		return httpx.InvalidTask
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf}), &fields) != nil || len(fields) != 2 {
		return httpx.InvalidTask
	}
	name, ok := httpx.WellFormedString(fields["name"])
	name = strings.TrimSpace(name)
	if !ok || name == "" || utf8.RuneCountInString(name) > 120 {
		return httpx.InvalidTask
	}
	var source map[string]json.RawMessage
	if json.Unmarshal(fields["source"], &source) != nil || source == nil {
		return httpx.InvalidTask
	}
	kind, _ := httpx.String(source["kind"])
	if kind == "space_snapshot" {
		var selection space.Selection
		var fileIDs []json.RawMessage
		if len(source) != 3 || json.Unmarshal(source["fileIds"], &fileIDs) != nil || len(fileIDs) == 0 {
			return httpx.InvalidTask
		}
		if len(fileIDs) > 100 {
			return httpx.NewError(413, "too_large", "任务快照最多 100 个文件。")
		}
		selection.Kind = kind
		selection.SpaceID, ok = httpx.WellFormedString(source["spaceId"])
		if !ok || !httpx.ResourceID(selection.SpaceID) {
			return httpx.NotFound
		}
		for _, rawID := range fileIDs {
			id, ok := httpx.WellFormedString(rawID)
			if !ok || !httpx.ResourceID(id) {
				return httpx.NotFound
			}
			selection.FileIDs = append(selection.FileIDs, id)
		}
		slices.Sort(selection.FileIDs)
		for i := 1; i < len(selection.FileIDs); i++ {
			if selection.FileIDs[i-1] == selection.FileIDs[i] {
				return httpx.InvalidTask
			}
		}
		if snapshots == nil {
			return httpx.NewError(503, "source_unavailable", "空间文件入口暂不可用。")
		}
		return snapshots.CreateTask(w, r, owner, keys[0], name, selection)
	}
	if kind != "blank" || len(source) != 1 {
		return httpx.InvalidTask
	}
	return s.ForwardTask(w, r, owner, orchestrator.TaskRequest{Action: "create", Path: "/v1/tasks", Key: keys[0], Name: name})
}

func (s projectRoutes) serveTask(w http.ResponseWriter, r *http.Request, owner string) error {
	op, err := parseGoTask(w, r)
	if err != nil {
		return err
	}
	return s.ForwardTask(w, r, owner, op)
}
