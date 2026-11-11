package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const maxProjectRequest = 8 * 1024 * 1024

type projectService struct {
	origin string
	bearer string
	client *http.Client
}

type projectRoute struct {
	kind    string
	project string
	run     string
}

var notFound = &requestFailure{404, "not_found", "找不到该资源。"}
var backendUnavailable = &requestFailure{502, "backend_error", "任务服务暂不可用，请稍后重试。"}

func (r projectRoute) path() string {
	path := "/v1/projects"
	if r.project != "" {
		path += "/" + url.PathEscape(r.project)
	}
	if r.kind == "listRuns" || r.kind == "createRun" || r.run != "" {
		path += "/runs"
	}
	if r.run != "" {
		path += "/" + url.PathEscape(r.run)
	}
	if r.kind == "diff" {
		path += "/diff"
	}
	return path
}

func readProjectJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) error {
	media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if media != "application/json" {
		return &requestFailure{400, "invalid_content_type", "请使用 application/json。"}
	}
	if r.ContentLength > maxBytes {
		return &requestFailure{413, "too_large", "请求超过大小限制。"}
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBytes))
	var limit *http.MaxBytesError
	if errors.As(err, &limit) {
		return &requestFailure{413, "too_large", "请求超过大小限制。"}
	}
	if err != nil || !utf8.Valid(body) || !bytes.HasPrefix(bytes.TrimSpace(body), []byte("{")) ||
		json.Unmarshal(body, dst) != nil {
		return &requestFailure{400, "invalid_json", "请求内容必须是 UTF-8 JSON。"}
	}
	return nil
}

type projectInput struct {
	Name  string `json:"name"`
	Files []struct {
		Path string  `json:"path"`
		Text *string `json:"text"`
	} `json:"files"`
}

func (p *projectInput) validate() error {
	if strings.TrimSpace(p.Name) == "" || p.Files == nil {
		return &requestFailure{400, "invalid_project", "请提供项目名称和文件列表。"}
	}
	if len(p.Files) > 100 {
		return &requestFailure{413, "too_many_files", "项目最多包含 100 个文件。"}
	}
	paths := make(map[string]bool, len(p.Files))
	total := 0
	for _, file := range p.Files {
		if strings.Contains(file.Path, "\\") || strings.ContainsFunc(file.Path, unicode.IsControl) || paths[file.Path] {
			return &requestFailure{400, "invalid_path", "文件路径无效或重复。"}
		}
		for _, part := range strings.Split(file.Path, "/") {
			if part == "" || part == "." || part == ".." || part == ".git" {
				return &requestFailure{400, "invalid_path", "文件路径无效或重复。"}
			}
		}
		if file.Text == nil {
			return &requestFailure{400, "invalid_file", "文件必须是 UTF-8 文本。"}
		}
		paths[file.Path] = true
		total += len(*file.Text)
	}
	for path := range paths {
		for index := strings.IndexByte(path, '/'); index >= 0; {
			if paths[path[:index]] {
				return &requestFailure{400, "path_conflict", "文件路径和目录路径冲突。"}
			}
			next := strings.IndexByte(path[index+1:], '/')
			if next < 0 {
				break
			}
			index += next + 1
		}
	}
	if total > 1024*1024 {
		return &requestFailure{413, "project_too_large", "项目文本内容最多 1 MiB。"}
	}
	return nil
}

func projectResourceID(value string) bool {
	return value != "" && value != "." && value != ".." &&
		!strings.ContainsAny(value, "/\\") && !strings.ContainsFunc(value, unicode.IsControl)
}

type projectView struct {
	ID        string  `json:"id"`
	Name      *string `json:"name"`
	Status    string  `json:"status"`
	CreatedAt string  `json:"createdAt"`
}

func (p projectView) valid(id string) bool {
	switch p.Status {
	case "importing", "ready", "failed":
		return projectResourceID(p.ID) && (id == "" || p.ID == id) && p.Name != nil && validTimestamp(p.CreatedAt)
	}
	return false
}

type runView struct {
	ID        string  `json:"id"`
	Project   string  `json:"projectId"`
	Session   string  `json:"sessionId"`
	Status    string  `json:"status"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
	Summary   *string `json:"summary,omitempty"`
	Prompt    *string `json:"prompt,omitempty"`
}

func (r *runView) valid(project, run string) bool {
	if run == "" {
		r.Prompt = nil
	}
	switch r.Status {
	case "queued", "running", "recovering", "needs_review", "succeeded", "failed":
		return projectResourceID(r.ID) && (run == "" || run == r.ID) && r.Project == project &&
			projectResourceID(r.Session) && validTimestamp(r.CreatedAt) && validTimestamp(r.UpdatedAt)
	}
	return false
}

func validTimestamp(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func (route projectRoute) decode(raw []byte) (any, error) {
	switch route.kind {
	case "listProjects":
		var result struct {
			Projects []projectView `json:"projects"`
		}
		if json.Unmarshal(raw, &result) == nil && result.Projects != nil {
			for _, project := range result.Projects {
				if !project.valid("") {
					return nil, backendUnavailable
				}
			}
			return result, nil
		}
	case "project", "createProject":
		var result projectView
		if json.Unmarshal(raw, &result) == nil && result.valid(route.project) {
			return result, nil
		}
	case "listRuns":
		var result struct {
			Runs []runView `json:"runs"`
		}
		if json.Unmarshal(raw, &result) == nil && result.Runs != nil {
			for i := range result.Runs {
				if !result.Runs[i].valid(route.project, "") {
					return nil, backendUnavailable
				}
			}
			return result, nil
		}
	case "run", "createRun":
		var result runView
		if json.Unmarshal(raw, &result) == nil && result.valid(route.project, route.run) {
			return result, nil
		}
	case "diff":
		if utf8.Valid(raw) {
			return string(raw), nil
		}
	}
	return nil, backendUnavailable
}

func projectBackendError(status int, kind string) error {
	switch status {
	case 400:
		return &requestFailure{400, "invalid_input", "任务服务拒绝了请求内容。"}
	case 404:
		return notFound
	case 409:
		message := "当前项目状态不允许提交，或此提交键已用于其他内容。"
		if kind == "diff" {
			message = "成果尚未可用。"
		}
		return &requestFailure{409, "conflict", message}
	case 413:
		return &requestFailure{413, "too_large", "导入内容超过任务服务的限制。"}
	case 429:
		return &requestFailure{429, "tenant_queue_full", "当前账号的任务队列已满。等一个排队任务开始后再提交。"}
	default:
		return backendUnavailable
	}
}

func (s projectService) invoke(ctx context.Context, owner, key string, route projectRoute, input any) (int, any, error) {
	method := "GET"
	var body io.Reader
	if input != nil {
		method = "POST"
		raw, err := json.Marshal(input)
		if err != nil {
			return 0, nil, err
		}
		body = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method, s.origin+route.path(), body)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Authorization", "Bearer "+s.bearer)
	request.Header.Set("X-Bento-Owner-Id", owner)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	response, err := s.client.Do(request)
	if err != nil {
		var timeout interface{ Timeout() bool }
		if errors.As(err, &timeout) && timeout.Timeout() {
			return 0, nil, &requestFailure{504, "backend_timeout", "任务服务响应超时，请用原提交重试。"}
		}
		return 0, nil, backendUnavailable
	}
	defer response.Body.Close()
	status := response.StatusCode
	if status < 200 || status >= 300 {
		return 0, nil, projectBackendError(status, route.kind)
	}

	wantType := "application/json"
	wantStatus := 200
	switch route.kind {
	case "createProject":
		wantStatus = 201
	case "createRun":
		wantStatus = 202
	case "diff":
		wantType = "text/plain"
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if media != wantType || (status != wantStatus && !(key != "" && status == 200 &&
		(route.kind == "createRun" || route.kind == "createProject"))) {
		return 0, nil, backendUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxProjectRequest+1))
	if err != nil || len(raw) > maxProjectRequest {
		return 0, nil, backendUnavailable
	}
	result, err := route.decode(raw)
	return status, result, err
}

func (s projectService) routes(mux *http.ServeMux, sessions *webSessions, origin string) {
	register := func(pattern, kind string) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "POST" && (r.Header.Get("Origin") != origin || len(r.Header.Values("Origin")) != 1) {
				authFailure(w, &requestFailure{400, "invalid_origin", "请从任务入口提交请求。"})
				return
			}
			saved, err := sessions.current(r)
			if err == nil {
				err = s.handle(w, r, saved.Owner, kind)
			}
			if err != nil {
				authFailure(w, err)
			}
		})
	}
	register("GET /api/projects", "listProjects")
	register("POST /api/projects", "createProject")
	register("GET /api/projects/{project}", "project")
	register("GET /api/projects/{project}/runs", "listRuns")
	register("POST /api/projects/{project}/runs", "createRun")
	register("GET /api/projects/{project}/runs/{run}", "run")
	register("GET /api/projects/{project}/runs/{run}/diff", "diff")
}

func (s projectService) handle(w http.ResponseWriter, r *http.Request, owner, kind string) error {
	route := projectRoute{kind: kind, project: r.PathValue("project"), run: r.PathValue("run")}
	if (route.project != "" && !projectResourceID(route.project)) ||
		(route.run != "" && !projectResourceID(route.run)) {
		return notFound
	}
	var input any
	var key string
	switch kind {
	case "createProject":
		var project projectInput
		if err := readProjectJSON(w, r, maxProjectRequest, &project); err != nil {
			return err
		}
		if err := project.validate(); err != nil {
			return err
		}
		input = project
	case "createRun":
		keys := r.Header.Values("Idempotency-Key")
		if len(keys) != 1 || keys[0] == "" ||
			strings.ContainsFunc(keys[0], func(r rune) bool { return r < '!' || r > '~' }) {
			return &requestFailure{400, "invalid_key", "请提供一个有效的 Idempotency-Key。"}
		}
		key = keys[0]
		var run struct {
			Prompt string `json:"prompt"`
		}
		if err := readProjectJSON(w, r, 64*1024, &run); err != nil {
			return err
		}
		run.Prompt = strings.TrimSpace(run.Prompt)
		if run.Prompt == "" || utf8.RuneCountInString(run.Prompt) > 8000 {
			return &requestFailure{400, "invalid_prompt", "请输入 1 至 8000 个字符的任务说明。"}
		}
		input = run
	}
	status, result, err := s.invoke(r.Context(), owner, key, route, input)
	if err != nil {
		return err
	}
	if kind == "diff" {
		if r.URL.Query().Get("download") == "1" {
			w.Header().Set("Content-Disposition", `attachment; filename="bento.diff"`)
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(status)
		_, _ = fmt.Fprint(w, result)
		return nil
	}
	authJSON(w, status, result)
	return nil
}
