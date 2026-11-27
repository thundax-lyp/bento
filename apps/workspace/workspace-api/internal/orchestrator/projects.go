package orchestrator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"time"
	"unicode/utf8"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/httpx"
)

const MaxProjectRequest = 8 * 1024 * 1024

type ProjectRoute struct {
	Kind    string
	Project string
	Run     string
}

func (r ProjectRoute) path() string {
	path := "/v1/projects"
	if r.Project != "" {
		path += "/" + url.PathEscape(r.Project)
	}
	if r.Kind == "listRuns" || r.Kind == "createRun" || r.Run != "" {
		path += "/runs"
	}
	if r.Run != "" {
		path += "/" + url.PathEscape(r.Run)
	}
	switch r.Kind {
	case "diff":
		path += "/diff"
	case "cancelRun":
		path += "/cancel"
	}
	return path
}

type ProjectFile struct {
	Path string `json:"path"`
	Text string `json:"text"`
}

type ProjectInput struct {
	Name  string        `json:"name"`
	Files []ProjectFile `json:"files"`
}

type ProjectView struct {
	ID        string  `json:"id"`
	Name      *string `json:"name"`
	Status    string  `json:"status"`
	CreatedAt string  `json:"createdAt"`
}

func (p ProjectView) valid(id string) bool {
	switch p.Status {
	case "importing", "ready", "failed":
		return httpx.ResourceID(p.ID) && (id == "" || p.ID == id) && p.Name != nil && validTimestamp(p.CreatedAt)
	}
	return false
}

type RunView struct {
	ID        string  `json:"id"`
	Project   string  `json:"projectId"`
	Session   string  `json:"sessionId"`
	Status    string  `json:"status"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
	Summary   *string `json:"summary,omitempty"`
	Prompt    *string `json:"prompt,omitempty"`
}

func (r *RunView) valid(project, run string) bool {
	if run == "" {
		r.Prompt = nil
	}
	switch r.Status {
	case "pending_approval", "queued", "running", "recovering", "needs_review", "cancelling", "cancelled", "succeeded", "failed":
		return httpx.ResourceID(r.ID) && (run == "" || run == r.ID) && r.Project == project &&
			httpx.ResourceID(r.Session) && validTimestamp(r.CreatedAt) && validTimestamp(r.UpdatedAt)
	}
	return false
}

func validTimestamp(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func (route ProjectRoute) decode(raw []byte) (any, error) {
	switch route.Kind {
	case "listProjects":
		var result struct {
			Projects []ProjectView `json:"projects"`
		}
		if json.Unmarshal(raw, &result) == nil && result.Projects != nil {
			for _, project := range result.Projects {
				if !project.valid("") {
					return nil, httpx.BackendUnavailable
				}
			}
			return result, nil
		}
	case "project", "createProject":
		var result ProjectView
		if json.Unmarshal(raw, &result) == nil && result.valid(route.Project) {
			return result, nil
		}
	case "listRuns":
		var result struct {
			Runs []RunView `json:"runs"`
		}
		if json.Unmarshal(raw, &result) == nil && result.Runs != nil {
			for i := range result.Runs {
				if !result.Runs[i].valid(route.Project, "") {
					return nil, httpx.BackendUnavailable
				}
			}
			return result, nil
		}
	case "run", "createRun", "cancelRun":
		var result RunView
		if json.Unmarshal(raw, &result) == nil && result.valid(route.Project, route.Run) {
			if route.Kind == "cancelRun" && result.Status != "cancelling" && result.Status != "cancelled" && result.Status != "needs_review" {
				return nil, httpx.BackendUnavailable
			}
			return result, nil
		}
	case "diff":
		if utf8.Valid(raw) {
			return string(raw), nil
		}
	}
	return nil, httpx.BackendUnavailable
}

func projectBackendError(status int, kind string) error {
	switch status {
	case 400:
		return httpx.NewError(400, "invalid_input", "任务服务拒绝了请求内容。")
	case 404:
		return httpx.NotFound
	case 409:
		message := "当前项目状态不允许提交，或此提交键已用于其他内容。"
		switch kind {
		case "diff":
			message = "成果尚未可用。"
		case "cancelRun":
			message = "当前任务状态不能取消。"
		}
		return httpx.NewError(409, "conflict", message)
	case 413:
		return httpx.NewError(413, "too_large", "导入内容超过任务服务的限制。")
	case 429:
		return httpx.NewError(429, "tenant_queue_full", "当前账号的任务队列已满。等一个排队任务开始后再提交。")
	default:
		return httpx.BackendUnavailable
	}
}

func (s Client) Invoke(ctx context.Context, owner, key string, route ProjectRoute, input any) (int, any, error) {
	method := http.MethodGet
	if route.Kind == "cancelRun" {
		method = http.MethodPost
	}
	var body io.Reader
	if input != nil {
		method = "POST"
		raw, err := json.Marshal(input)
		if err != nil {
			return 0, nil, err
		}
		body = bytes.NewReader(raw)
	}
	response, err := s.request(ctx, method, route.path(), owner, key, body)
	if err != nil {
		var timeout interface{ Timeout() bool }
		if errors.As(err, &timeout) && timeout.Timeout() {
			return 0, nil, httpx.NewError(504, "backend_timeout", "任务服务响应超时，请用原提交重试。")
		}
		return 0, nil, httpx.BackendUnavailable
	}
	defer response.Body.Close()
	status := response.StatusCode
	if status < 200 || status >= 300 {
		return 0, nil, projectBackendError(status, route.Kind)
	}

	wantType := "application/json"
	wantStatus := 200
	switch route.Kind {
	case "createProject":
		wantStatus = 201
	case "createRun":
		wantStatus = 202
	case "diff":
		wantType = "text/plain"
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if media != wantType || (status != wantStatus && !(key != "" && status == 200 &&
		(route.Kind == "createRun" || route.Kind == "createProject"))) {
		return 0, nil, httpx.BackendUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, MaxProjectRequest+1))
	if err != nil || len(raw) > MaxProjectRequest {
		return 0, nil, httpx.BackendUnavailable
	}
	result, err := route.decode(raw)
	return status, result, err
}
