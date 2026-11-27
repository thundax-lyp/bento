package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

var (
	taskUUID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
	taskPath = regexp.MustCompile(`^/api/tasks/([^/]+)(?:/(prepare|events|runs)(?:/([^/]+)(?:/(cancel|retry|results)(?:/(1)/diff)?)?)?)?$`)
	taskHex  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	taskSeq  = regexp.MustCompile(`^[0-9]+$`)
	badTask  = &requestFailure{400, "invalid_input", "任务请求内容无效。"}
	badKey   = &requestFailure{400, "invalid_key", "提交键无效。"}
)

type taskRequest struct {
	action, task, run, key string
	path                   string
	query                  url.Values
	prompt                 string
	name                   string
	input                  json.RawMessage
	accept                 func(any) error
}

func parseGoTask(w http.ResponseWriter, r *http.Request) (taskRequest, error) {
	var result taskRequest
	path := r.URL.EscapedPath()
	if path == "/api/tasks" && r.Method == http.MethodGet {
		result.action = "list"
	} else {
		match := taskPath.FindStringSubmatch(path)
		if len(match) == 0 || !taskUUID.MatchString(match[1]) ||
			(match[3] != "" && !taskUUID.MatchString(match[3])) {
			return result, notFound
		}
		result.task, result.run = match[1], match[3]
		section, mode, version := match[2], match[4], match[5]
		switch {
		case section == "" && r.Method == http.MethodGet:
			result.action = "task"
		case section == "prepare" && result.run == "" && r.Method == http.MethodPost:
			result.action = "prepare"
		case section == "events" && result.run == "" && r.Method == http.MethodGet:
			result.action = "events"
		case section == "runs" && result.run == "" && r.Method == http.MethodGet:
			result.action = "listRuns"
		case section == "runs" && result.run == "" && r.Method == http.MethodPost:
			result.action = "createRun"
		case section == "runs" && result.run != "" && mode == "" && r.Method == http.MethodGet:
			result.action = "run"
		case section == "runs" && mode == "cancel" && version == "" && r.Method == http.MethodPost:
			result.action = "cancel"
		case section == "runs" && mode == "retry" && version == "" && r.Method == http.MethodPost:
			result.action = "retry"
		case section == "runs" && mode == "results" && r.Method == http.MethodGet:
			result.action = "result"
			if version != "" {
				result.action = "diff"
			}
		default:
			return result, notFound
		}
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return result, badTask
	}
	for key, values := range query {
		if len(values) != 1 ||
			!(result.action == "events" && key == "after" || result.action == "diff" && (key == "view" || key == "download")) {
			return result, badTask
		}
	}
	if result.action == "events" && query.Has("after") {
		after := query.Get("after")
		sequence, err := strconv.ParseUint(after, 10, 53)
		if !taskSeq.MatchString(after) || err != nil || sequence > 1<<53-1 {
			return result, badTask
		}
	}
	if result.action == "diff" {
		view := query.Get("view")
		if view != "incremental" && view != "cumulative" || query.Has("download") && query.Get("download") != "1" {
			return result, badTask
		}
	}
	if result.action == "createRun" || result.action == "retry" {
		keys := r.Header.Values("Idempotency-Key")
		if len(keys) != 1 || !taskUUID.MatchString(keys[0]) {
			return result, badKey
		}
		result.key = keys[0]
	}
	if result.action == "createRun" {
		fields, err := readProjectJSON(w, r, 64*1024)
		if err != nil {
			var failure *requestFailure
			if errors.As(err, &failure) && failure.status == 400 {
				return result, badTask
			}
			return result, err
		}
		if len(fields) != 1 {
			return result, badTask
		}
		prompt, _ := projectString(fields["prompt"])
		result.prompt = strings.TrimSpace(prompt)
		if result.prompt == "" || utf8.RuneCountInString(result.prompt) > 8000 {
			return result, &requestFailure{400, "invalid_prompt", "任务描述须为 1 至 8000 个字符。"}
		}
	} else if r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
		return result, &requestFailure{400, "invalid_input", "此任务请求不接受正文。"}
	}
	result.path = "/v1" + strings.TrimPrefix(path, "/api")
	result.query = query
	return result, nil
}

type taskProjection func(json.RawMessage) (any, error)

func taskObject(raw json.RawMessage, fields map[string]taskProjection) (any, error) {
	var row map[string]json.RawMessage
	if json.Unmarshal(raw, &row) != nil || row == nil {
		return nil, backendUnavailable
	}
	result := make(map[string]any, len(fields))
	for name, project := range fields {
		value, err := project(row[name])
		if err != nil {
			return nil, err
		}
		result[name] = value
	}
	return result, nil
}

func taskArray(project taskProjection) taskProjection {
	return func(raw json.RawMessage) (any, error) {
		var rows []json.RawMessage
		if json.Unmarshal(raw, &rows) != nil || rows == nil {
			return nil, backendUnavailable
		}
		result := make([]any, 0, len(rows))
		for _, row := range rows {
			value, err := project(row)
			if err != nil {
				return nil, err
			}
			result = append(result, value)
		}
		return result, nil
	}
}

func taskString(valid func(string) bool) taskProjection {
	return func(raw json.RawMessage) (any, error) {
		value, ok := projectString(raw)
		if !ok || (valid != nil && !valid(value)) {
			return nil, backendUnavailable
		}
		return value, nil
	}
}

func taskEnum(allowed ...string) taskProjection {
	return taskString(func(value string) bool {
		for _, item := range allowed {
			if item == value {
				return true
			}
		}
		return false
	})
}

func taskNullable(project taskProjection) taskProjection {
	return func(raw json.RawMessage) (any, error) {
		if bytes.Equal(raw, []byte("null")) {
			return nil, nil
		}
		return project(raw)
	}
}

func taskInteger(min int64) taskProjection {
	return func(raw json.RawMessage) (any, error) {
		var number *float64
		if json.Unmarshal(raw, &number) != nil || number == nil || *number < float64(min) ||
			*number > 1<<53-1 || *number != float64(int64(*number)) {
			return nil, backendUnavailable
		}
		return int64(*number), nil
	}
}

func taskBool(raw json.RawMessage) (any, error) {
	switch string(raw) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return nil, backendUnavailable
	}
}

func projectTask(raw json.RawMessage) (any, error) {
	id, text, timestamp := taskString(projectResourceID), taskString(nil), taskString(validTimestamp)
	digest := taskString(taskHex.MatchString)
	return taskObject(raw, map[string]taskProjection{
		"id": id, "name": text, "sourceSpaceId": taskNullable(text), "inputDigest": digest,
		"environmentVersion": taskString(func(s string) bool { return strings.HasPrefix(s, "sha256:") && taskHex.MatchString(s[7:]) }),
		"status":             taskEnum("preparing", "ready", "failed", "deleting"),
		"prepareError":       taskNullable(text), "closedReason": taskNullable(text),
		"reconciliation": taskNullable(func(raw json.RawMessage) (any, error) {
			return taskObject(raw, map[string]taskProjection{
				"attemptId": id, "state": taskEnum("blocked"), "reason": taskEnum("restore_conflict"),
			})
		}),
		"createdAt": timestamp, "updatedAt": timestamp,
		"inputs": taskArray(func(raw json.RawMessage) (any, error) {
			return taskObject(raw, map[string]taskProjection{"fileId": id, "path": text, "bytes": taskInteger(0), "sha256": digest})
		}),
	})
}

func (op taskRequest) projectResponse(raw json.RawMessage) (any, error) {
	id, text, timestamp := taskString(projectResourceID), taskString(nil), taskString(validTimestamp)
	positive := taskInteger(1)
	run := func(raw json.RawMessage) (any, error) {
		value, err := taskObject(raw, map[string]taskProjection{
			"id": id, "taskId": id, "sequence": positive, "prompt": text,
			"status":  taskEnum("pending_approval", "queued", "running", "recovering", "needs_review", "cancelling", "cancelled", "succeeded", "failed"),
			"retryOf": taskNullable(text), "canContinue": taskBool, "canCancel": taskBool,
			"retryReason": taskNullable(text), "resultVersion": taskNullable(positive), "summary": taskNullable(text),
			"createdAt": timestamp, "updatedAt": timestamp,
		})
		if err != nil {
			return nil, err
		}
		row := value.(map[string]any)
		if row["taskId"] != op.task || (op.run != "" && row["id"] != op.run) {
			return nil, backendUnavailable
		}
		return row, nil
	}
	check := func(raw json.RawMessage) (any, error) {
		return taskObject(raw, map[string]taskProjection{
			"name": text, "status": taskEnum("passed", "failed", "not_run", "unavailable"), "output": taskNullable(text),
		})
	}
	switch op.action {
	case "create":
		return taskObject(raw, map[string]taskProjection{"task": projectTask})
	case "list":
		return taskObject(raw, map[string]taskProjection{"items": taskArray(projectTask)})
	case "task", "prepare":
		return taskObject(raw, map[string]taskProjection{"task": func(raw json.RawMessage) (any, error) {
			task, err := projectTask(raw)
			if err != nil || task.(map[string]any)["id"] != op.task {
				return nil, backendUnavailable
			}
			return task, nil
		}})
	case "listRuns":
		return taskObject(raw, map[string]taskProjection{"items": taskArray(run)})
	case "run", "createRun", "cancel":
		return taskObject(raw, map[string]taskProjection{"run": run})
	case "events":
		return taskObject(raw, map[string]taskProjection{"items": taskArray(func(raw json.RawMessage) (any, error) {
			return taskObject(raw, map[string]taskProjection{
				"id": text, "sequence": positive, "runId": id, "at": timestamp,
				"kind": taskEnum("user_message", "agent_reply", "step", "command", "check"), "text": text, "check": taskNullable(check),
			})
		})})
	case "result":
		return taskObject(raw, map[string]taskProjection{"result": func(raw json.RawMessage) (any, error) {
			digest := taskString(taskHex.MatchString)
			item, err := taskObject(raw, map[string]taskProjection{
				"runId": id, "version": positive, "summary": text, "checks": taskArray(check),
				"incrementalSha256": digest, "cumulativeSha256": digest, "createdAt": timestamp,
			})
			if err != nil {
				return nil, err
			}
			row := item.(map[string]any)
			if row["runId"] != op.run || row["version"] != int64(1) {
				return nil, backendUnavailable
			}
			return row, nil
		}})
	case "retry":
		return taskObject(raw, map[string]taskProjection{"retry": func(raw json.RawMessage) (any, error) {
			return taskObject(raw, map[string]taskProjection{
				"id": id, "runId": id, "state": taskEnum("preparing", "queued", "blocked", "closed"),
			})
		}})
	}
	return nil, backendUnavailable
}

func (s projectService) taskRoutes(mux *http.ServeMux, sessions *webSessions, origin string, legacy http.Handler) {
	handle := func(w http.ResponseWriter, r *http.Request) {
		s.responseHeaders(w)
		if r.Method == http.MethodPost && (len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != origin) {
			authFailure(w, &requestFailure{400, "invalid_origin", "请从任务入口提交请求。"})
			return
		}
		session, err := sessions.current(r)
		if err == nil {
			if r.Method == http.MethodPost && r.URL.EscapedPath() == "/api/tasks" {
				err = s.createTask(w, r, session.Owner, legacy)
			} else {
				err = s.serveTask(w, r, session.Owner)
			}
		}
		if err != nil {
			authFailure(w, err)
		}
	}
	mux.HandleFunc("GET /api/tasks", handle)
	mux.HandleFunc("POST /api/tasks", handle)
	mux.HandleFunc("GET /api/tasks/", handle)
	mux.HandleFunc("POST /api/tasks/", handle)
}

func (s projectService) createTask(w http.ResponseWriter, r *http.Request, owner string, legacy http.Handler) error {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query) != 0 {
		return badTask
	}
	keys := r.Header.Values("Idempotency-Key")
	if len(keys) != 1 || !taskUUID.MatchString(keys[0]) {
		return badKey
	}
	const limit = 64 * 1024
	media := strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0])
	if !strings.EqualFold(media, "application/json") {
		return badTask
	}
	tooLarge := &requestFailure{413, "too_large", "请求超过大小限制。"}
	if r.ContentLength > limit {
		return tooLarge
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	var sizeError *http.MaxBytesError
	if errors.As(err, &sizeError) {
		return tooLarge
	}
	if err != nil || !utf8.Valid(raw) {
		return badTask
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf}), &fields) != nil || len(fields) != 2 {
		return badTask
	}
	name, ok := wellFormedProjectString(fields["name"])
	name = strings.TrimSpace(name)
	if !ok || name == "" || utf8.RuneCountInString(name) > 120 {
		return badTask
	}
	var source map[string]json.RawMessage
	if json.Unmarshal(fields["source"], &source) != nil || source == nil {
		return badTask
	}
	kind, _ := projectString(source["kind"])
	if kind == "space_snapshot" {
		// Snapshot selection and retention still share the existing file-space transaction.
		r.Body = io.NopCloser(bytes.NewReader(raw))
		legacy.ServeHTTP(w, r)
		return nil
	}
	if kind != "blank" || len(source) != 1 {
		return badTask
	}
	return s.forwardTask(w, r, owner, taskRequest{action: "create", path: "/v1/tasks", key: keys[0], name: name})
}

func (s projectService) serveTask(w http.ResponseWriter, r *http.Request, owner string) error {
	op, err := parseGoTask(w, r)
	if err != nil {
		return err
	}
	return s.forwardTask(w, r, owner, op)
}

func (s projectService) forwardTask(w http.ResponseWriter, r *http.Request, owner string, op taskRequest) error {
	upstream := s.origin + op.path
	if len(op.query) != 0 {
		upstream += "?" + op.query.Encode()
	}
	var input map[string]any
	if op.action == "create" && op.input == nil {
		hash := sha256.Sum256([]byte("[]"))
		input = map[string]any{
			"id": nil, "name": op.name, "sourceSpaceId": nil, "inputFiles": []any{},
			"inputManifest": []any{}, "inputDigest": hex.EncodeToString(hash[:]),
		}
	} else if op.prompt != "" {
		input = map[string]any{"prompt": op.prompt}
	}
	var body io.Reader
	if op.input != nil {
		body = bytes.NewReader(op.input)
	} else if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(r.Context(), r.Method, upstream, body)
	if err != nil {
		return backendUnavailable
	}
	request.Header.Set("Authorization", "Bearer "+s.bearer)
	request.Header.Set("X-Bento-Owner-Id", owner)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if op.key != "" {
		request.Header.Set("Idempotency-Key", op.key)
	}
	response, err := s.client.Do(request)
	if err != nil {
		return backendUnavailable
	}
	defer response.Body.Close()
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	status := response.StatusCode
	if status == 404 {
		return notFound
	}
	if status != 200 && !(status == 202 && (op.action == "create" || op.action == "createRun" || op.action == "retry")) {
		if media == "application/json" && (status == 400 || status == 409) {
			var failure struct {
				Error struct{ Code, Reason string } `json:"error"`
			}
			raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
			if err != nil || len(raw) > 64*1024 || json.Unmarshal(raw, &failure) != nil {
				return backendUnavailable
			}
			code := failure.Error.Code
			allowed := taskEnum("invalid_input", "invalid_key")
			if status == 409 {
				allowed = taskEnum("idempotency_conflict", "task_not_ready", "task_busy", "run_not_cancellable", "run_not_retryable",
					"diff_unavailable", "project_busy", "project_importing", "owner_closed", "deletion_released", "deletion_not_held", "deletion_committed")
			}
			encoded, _ := json.Marshal(code)
			if _, err := allowed(encoded); err != nil {
				return backendUnavailable
			}
			body := map[string]string{"code": code, "message": "当前请求无法执行。"}
			if code == "run_not_retryable" {
				reason := failure.Error.Reason
				known := taskEnum("task_closed", "not_latest", "not_terminal", "needs_review", "stop_unconfirmed",
					"checkpoint_unavailable", "environment_unavailable", "task_busy", "task_not_ready")
				encoded, _ := json.Marshal(reason)
				if _, err := known(encoded); err == nil {
					body["reason"] = reason
				}
			}
			authJSON(w, status, map[string]any{"error": body})
			return nil
		}
		return projectBackendError(status, "")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxProjectRequest+1))
	if err != nil || len(raw) > maxProjectRequest {
		return backendUnavailable
	}
	if op.action == "diff" {
		if media != "text/plain" || !utf8.Valid(raw) {
			return backendUnavailable
		}
		if op.query.Get("download") == "1" {
			w.Header().Set("Content-Disposition", `attachment; filename="changes.patch"`)
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(raw)
		return nil
	}
	if media != "application/json" {
		return backendUnavailable
	}
	value, err := op.projectResponse(raw)
	if err != nil {
		return err
	}
	if op.accept != nil {
		if err := op.accept(value); err != nil {
			return err
		}
	}
	authJSON(w, status, value)
	return nil
}
