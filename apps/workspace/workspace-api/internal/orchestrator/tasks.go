package orchestrator

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/httpx"
)

var (
	taskUUID   = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
	taskDigest = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func ValidTaskID(value string) bool { return taskUUID.MatchString(value) }
func ValidDigest(value string) bool { return taskDigest.MatchString(value) }

type TaskRequest struct {
	Action, Task, Run, Key string
	Path                   string
	Query                  url.Values
	Prompt                 string
	Name                   string
	Input                  json.RawMessage
	Accept                 func(any) error
	Reject                 func(string) error
}

type taskProjection func(json.RawMessage) (any, error)

func taskObject(raw json.RawMessage, fields map[string]taskProjection) (any, error) {
	var row map[string]json.RawMessage
	if json.Unmarshal(raw, &row) != nil || row == nil {
		return nil, httpx.BackendUnavailable
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
			return nil, httpx.BackendUnavailable
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
		value, ok := httpx.String(raw)
		if !ok || (valid != nil && !valid(value)) {
			return nil, httpx.BackendUnavailable
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
		number, ok := httpx.Integer(raw, min)
		if !ok {
			return nil, httpx.BackendUnavailable
		}
		return number, nil
	}
}

func taskBool(raw json.RawMessage) (any, error) {
	switch string(raw) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return nil, httpx.BackendUnavailable
	}
}

func projectTask(raw json.RawMessage) (any, error) {
	id, text, timestamp := taskString(httpx.ResourceID), taskString(nil), taskString(validTimestamp)
	digest := taskString(taskDigest.MatchString)
	return taskObject(raw, map[string]taskProjection{
		"id": id, "name": text, "sourceSpaceId": taskNullable(text), "inputDigest": digest,
		"environmentVersion": taskString(func(s string) bool { return strings.HasPrefix(s, "sha256:") && taskDigest.MatchString(s[7:]) }),
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

func (op TaskRequest) projectResponse(raw json.RawMessage) (any, error) {
	id, text, timestamp := taskString(httpx.ResourceID), taskString(nil), taskString(validTimestamp)
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
		if row["taskId"] != op.Task || (op.Run != "" && row["id"] != op.Run) {
			return nil, httpx.BackendUnavailable
		}
		return row, nil
	}
	check := func(raw json.RawMessage) (any, error) {
		return taskObject(raw, map[string]taskProjection{
			"name": text, "status": taskEnum("passed", "failed", "not_run", "unavailable"), "output": taskNullable(text),
		})
	}
	switch op.Action {
	case "create":
		return taskObject(raw, map[string]taskProjection{"task": projectTask})
	case "list":
		return taskObject(raw, map[string]taskProjection{"items": taskArray(projectTask)})
	case "task", "prepare":
		return taskObject(raw, map[string]taskProjection{"task": func(raw json.RawMessage) (any, error) {
			task, err := projectTask(raw)
			if err != nil || task.(map[string]any)["id"] != op.Task {
				return nil, httpx.BackendUnavailable
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
			digest := taskString(taskDigest.MatchString)
			item, err := taskObject(raw, map[string]taskProjection{
				"runId": id, "version": positive, "summary": text, "checks": taskArray(check),
				"incrementalSha256": digest, "cumulativeSha256": digest, "createdAt": timestamp,
			})
			if err != nil {
				return nil, err
			}
			row := item.(map[string]any)
			if row["runId"] != op.Run || row["version"] != int64(1) {
				return nil, httpx.BackendUnavailable
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
	return nil, httpx.BackendUnavailable
}

func (s Client) ForwardTask(w http.ResponseWriter, r *http.Request, owner string, op TaskRequest) error {
	upstream := op.Path
	if len(op.Query) != 0 {
		upstream += "?" + op.Query.Encode()
	}
	var input map[string]any
	if op.Action == "create" && op.Input == nil {
		hash := sha256.Sum256([]byte("[]"))
		input = map[string]any{
			"id": nil, "name": op.Name, "sourceSpaceId": nil, "inputFiles": []any{},
			"inputManifest": []any{}, "inputDigest": hex.EncodeToString(hash[:]),
		}
	} else if op.Prompt != "" {
		input = map[string]any{"prompt": op.Prompt}
	}
	var body io.Reader
	if op.Input != nil {
		body = bytes.NewReader(op.Input)
	} else if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	response, err := s.request(r.Context(), r.Method, upstream, owner, op.Key, body)
	if err != nil {
		return httpx.BackendUnavailable
	}
	defer response.Body.Close()
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	status := response.StatusCode
	if status == 404 {
		return httpx.NotFound
	}
	if status != 200 && !(status == 202 && (op.Action == "create" || op.Action == "createRun" || op.Action == "retry")) {
		if media == "application/json" && (status == 400 || status == 409) {
			var failure struct {
				Error struct{ Code, Reason string } `json:"error"`
			}
			raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
			if err != nil || len(raw) > 64*1024 || json.Unmarshal(raw, &failure) != nil {
				return httpx.BackendUnavailable
			}
			code := failure.Error.Code
			allowed := taskEnum("invalid_input", "invalid_key")
			if status == 409 {
				allowed = taskEnum("idempotency_conflict", "task_not_ready", "task_busy", "run_not_cancellable", "run_not_retryable",
					"diff_unavailable", "project_busy", "project_importing", "owner_closed", "deletion_released", "deletion_not_held", "deletion_committed")
			}
			encoded, _ := json.Marshal(code)
			if _, err := allowed(encoded); err != nil {
				return httpx.BackendUnavailable
			}
			if op.Reject != nil {
				if err := op.Reject(code); err != nil {
					return err
				}
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
			if w == nil {
				return httpx.NewError(status, code, body["message"])
			}
			httpx.JSON(w, status, map[string]any{"error": body})
			return nil
		}
		return projectBackendError(status, "")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, MaxProjectRequest+1))
	if err != nil || len(raw) > MaxProjectRequest {
		return httpx.BackendUnavailable
	}
	if op.Action == "diff" {
		if media != "text/plain" || !utf8.Valid(raw) {
			return httpx.BackendUnavailable
		}
		if op.Query.Get("download") == "1" {
			w.Header().Set("Content-Disposition", `attachment; filename="changes.patch"`)
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(raw)
		return nil
	}
	if media != "application/json" {
		return httpx.BackendUnavailable
	}
	value, err := op.projectResponse(raw)
	if err != nil {
		return err
	}
	if op.Accept != nil {
		if err := op.Accept(value); err != nil {
			return err
		}
	}
	if w != nil {
		httpx.JSON(w, status, value)
	}
	return nil
}
