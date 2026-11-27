package orchestrator

import (
	"context"
	"encoding/json"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/httpx"
	"io"
	"mime"
	"net/http"
	"net/url"
)

var (
	FileDeleteUnconfirmed    = httpx.NewError(503, "file_delete_unconfirmed", "暂未确认删除结果，请刷新后重试。")
	ProjectDeleteUnconfirmed = httpx.NewError(503, "project_delete_unconfirmed", "暂无法确认项目删除进度，请重试。")
)

func (s Client) FileHold(ctx context.Context, owner, source, file, operation, legacyProject string, release bool) (string, error) {
	method := http.MethodPost
	if release {
		method = http.MethodDelete
	}
	path := "/v1/task-sources/" + url.PathEscape(source) + "/files/" + url.PathEscape(file) +
		"/deletion-holds/" + url.PathEscape(operation)
	if legacyProject != "" {
		path += "?" + url.Values{"legacyProjectId": {legacyProject}}.Encode()
	}
	response, err := s.request(ctx, method, path, owner, "", nil)
	if err != nil {
		return "", FileDeleteUnconfirmed
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return "", httpx.NotFound
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if media != "application/json" {
		return "", FileDeleteUnconfirmed
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil || len(raw) > 64*1024 {
		return "", FileDeleteUnconfirmed
	}
	if response.StatusCode == http.StatusConflict {
		var result struct {
			Error struct{ Code string } `json:"error"`
		}
		if json.Unmarshal(raw, &result) == nil && result.Error.Code == "owner_closed" {
			return "", httpx.NewError(409, "owner_closed", "当前请求无法执行。")
		}
	}
	var result struct {
		State string `json:"state"`
	}
	if response.StatusCode != http.StatusOK || json.Unmarshal(raw, &result) != nil {
		return "", FileDeleteUnconfirmed
	}
	switch result.State {
	case "held", "denied", "released":
		return result.State, nil
	default:
		return "", FileDeleteUnconfirmed
	}
}

func (s Client) DeleteSource(ctx context.Context, owner, id, operation, legacyProject, phase string) (int, string, error) {
	query := url.Values{"phase": {phase}}
	if legacyProject != "" {
		query.Set("legacyProjectId", legacyProject)
	}
	response, err := s.request(ctx, http.MethodDelete, "/v1/task-sources/"+url.PathEscape(id)+"?"+query.Encode(), owner, operation, nil)
	if err != nil {
		return 0, "", err
	}
	defer response.Body.Close()
	if response.StatusCode == 204 {
		return 204, "", nil
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if media != "application/json" {
		return 0, "", ProjectDeleteUnconfirmed
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	var reply struct {
		State string                `json:"state"`
		Error struct{ Code string } `json:"error"`
	}
	if err != nil || len(raw) > 64*1024 || json.Unmarshal(raw, &reply) != nil {
		return 0, "", ProjectDeleteUnconfirmed
	}
	if response.StatusCode == 409 {
		return 409, reply.Error.Code, nil
	}
	if response.StatusCode == 202 {
		return 202, reply.State, nil
	}
	return 0, "", ProjectDeleteUnconfirmed
}

func (s Client) SourceImpact(ctx context.Context, owner, id, legacyProject string) (int, int, []string, error) {
	target := "/v1/task-sources/" + url.PathEscape(id) + "/deletion"
	if legacyProject != "" {
		target += "?" + url.Values{"legacyProjectId": {legacyProject}}.Encode()
	}
	response, err := s.request(ctx, http.MethodGet, target, owner, "", nil)
	if err != nil {
		return 0, 0, nil, err
	}
	defer response.Body.Close()
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	var reply struct {
		RunCount  *int
		DiffCount *int
		Blockers  []string
	}
	if err != nil || len(raw) > 65536 || media != "application/json" || response.StatusCode != 200 || json.Unmarshal(raw, &reply) != nil ||
		reply.RunCount == nil || reply.DiffCount == nil || *reply.RunCount < 0 || *reply.DiffCount < 0 || reply.Blockers == nil {
		return 0, 0, nil, ProjectDeleteUnconfirmed
	}
	for _, code := range reply.Blockers {
		if code != "project_importing" && code != "project_busy" {
			return 0, 0, nil, ProjectDeleteUnconfirmed
		}
	}
	return *reply.RunCount, *reply.DiffCount, reply.Blockers, nil
}
