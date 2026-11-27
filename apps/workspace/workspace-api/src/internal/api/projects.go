package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/auth"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/httpx"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/orchestrator"
)

type projectRoutes struct {
	orchestrator.Client
	headers func(http.ResponseWriter)
}

func parseProjectInput(fields map[string]json.RawMessage) (orchestrator.ProjectInput, error) {
	name, ok := httpx.String(fields["name"])
	var files []json.RawMessage
	if !ok || strings.TrimSpace(name) == "" || json.Unmarshal(fields["files"], &files) != nil || files == nil {
		return orchestrator.ProjectInput{}, httpx.NewError(400, "invalid_project", "请提供项目名称和文件列表。")
	}
	if len(files) > 100 {
		return orchestrator.ProjectInput{}, httpx.NewError(413, "too_many_files", "项目最多包含 100 个文件。")
	}
	result := orchestrator.ProjectInput{Name: name, Files: make([]orchestrator.ProjectFile, 0, len(files))}
	paths := make(map[string]bool, len(files))
	total := 0
	for _, raw := range files {
		var file map[string]json.RawMessage
		if json.Unmarshal(raw, &file) != nil || file == nil {
			return orchestrator.ProjectInput{}, httpx.NewError(400, "invalid_input", "请求必须是 JSON 对象。")
		}
		path, ok := httpx.WellFormedString(file["path"])
		badPath := httpx.NewError(400, "invalid_path", "文件路径无效或重复。")
		if !ok || strings.Contains(path, "\\") || strings.ContainsFunc(path, unicode.IsControl) || paths[path] {
			return orchestrator.ProjectInput{}, badPath
		}
		for _, part := range strings.Split(path, "/") {
			if part == "" || part == "." || part == ".." || part == ".git" {
				return orchestrator.ProjectInput{}, badPath
			}
		}
		text, ok := httpx.WellFormedString(file["text"])
		if !ok {
			return orchestrator.ProjectInput{}, httpx.NewError(400, "invalid_file", "文件必须是 UTF-8 文本。")
		}
		result.Files = append(result.Files, orchestrator.ProjectFile{Path: path, Text: text})
		paths[path] = true
		total += len(text)
	}
	for path := range paths {
		for index := strings.IndexByte(path, '/'); index >= 0; {
			if paths[path[:index]] {
				return orchestrator.ProjectInput{}, httpx.NewError(400, "path_conflict", "文件路径和目录路径冲突。")
			}
			next := strings.IndexByte(path[index+1:], '/')
			if next < 0 {
				break
			}
			index += next + 1
		}
	}
	if total > 1024*1024 {
		return orchestrator.ProjectInput{}, httpx.NewError(413, "project_too_large", "项目文本内容最多 1 MiB。")
	}
	return result, nil
}

func (s projectRoutes) registerProjects(mux *http.ServeMux, current func(*http.Request) (*auth.Session, error), origin string) {
	register := func(pattern, kind string) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			s.headers(w)
			if r.Method == http.MethodHead {
				// ServeMux treats GET as matching HEAD. The Workspace API exposes GET only.
				if _, err := current(r); err != nil {
					httpx.Fail(w, err)
				} else {
					httpx.Fail(w, httpx.NotFound)
				}
				return
			}
			if r.Method == "POST" && (r.Header.Get("Origin") != origin || len(r.Header.Values("Origin")) != 1) {
				httpx.Fail(w, httpx.NewError(400, "invalid_origin", "请从任务入口提交请求。"))
				return
			}
			saved, err := current(r)
			if err == nil {
				err = s.handle(w, r, saved.Owner, kind)
			}
			if err != nil {
				httpx.Fail(w, err)
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
	register("POST /api/projects/{project}/runs/{run}/cancel", "cancelRun")
}

func (s projectRoutes) handle(w http.ResponseWriter, r *http.Request, owner, kind string) error {
	route := orchestrator.ProjectRoute{Kind: kind, Project: r.PathValue("project"), Run: r.PathValue("run")}
	if (route.Project != "" && !httpx.ResourceID(route.Project)) ||
		(route.Run != "" && !httpx.ResourceID(route.Run)) {
		return httpx.NotFound
	}
	var input any
	var key string
	switch kind {
	case "createProject":
		fields, err := httpx.ReadJSON(w, r, orchestrator.MaxProjectRequest)
		if err != nil {
			return err
		}
		project, err := parseProjectInput(fields)
		if err != nil {
			return err
		}
		input = project
	case "createRun":
		keys := r.Header.Values("Idempotency-Key")
		if len(keys) != 1 || keys[0] == "" ||
			strings.ContainsFunc(keys[0], func(r rune) bool { return r < '!' || r > '~' }) {
			return httpx.NewError(400, "invalid_key", "请提供一个有效的 Idempotency-Key。")
		}
		key = keys[0]
		fields, err := httpx.ReadJSON(w, r, 64*1024)
		if err != nil {
			return err
		}
		prompt, _ := httpx.String(fields["prompt"])
		prompt = strings.TrimSpace(prompt)
		if prompt == "" || utf8.RuneCountInString(prompt) > 8000 {
			return httpx.NewError(400, "invalid_prompt", "任务描述须为 1 至 8000 个字符。")
		}
		input = map[string]string{"prompt": prompt}
	}
	status, result, err := s.Invoke(r.Context(), owner, key, route, input)
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
	httpx.JSON(w, status, result)
	return nil
}
