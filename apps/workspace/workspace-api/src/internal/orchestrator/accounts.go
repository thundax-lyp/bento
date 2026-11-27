package orchestrator

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/httpx"
)

func (s Client) DrainOwner(ctx context.Context, owner string) error {
	_, err := s.accountRequest(ctx, owner, "/v1/account/drain", nil)
	return err
}

func (s Client) PurgeOwner(ctx context.Context, owner string) (bool, error) {
	return s.accountRequest(ctx, owner, "/v1/account/purge", []byte("{}"))
}

func (s Client) accountRequest(ctx context.Context, owner, path string, raw []byte) (bool, error) {
	var body io.Reader
	if raw != nil {
		body = bytes.NewReader(raw)
	}
	response, err := s.request(ctx, http.MethodPost, path, owner, "", body)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if raw == nil && response.StatusCode == http.StatusNoContent {
		return true, nil
	}
	if raw == nil || response.StatusCode != http.StatusOK && response.StatusCode != http.StatusAccepted {
		return false, httpx.BackendUnavailable
	}
	var result struct {
		Complete *bool `json:"complete"`
	}
	encoded, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(encoded) > 65536 || json.Unmarshal(encoded, &result) != nil || result.Complete == nil {
		return false, httpx.BackendUnavailable
	}
	return *result.Complete, nil
}
