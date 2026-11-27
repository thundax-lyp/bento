package orchestrator

import (
	"context"
	"io"
	"net/http"
)

type Client struct {
	origin, bearer string
	client         *http.Client
}

func NewClient(origin, bearer string, client *http.Client) Client {
	return Client{origin: origin, bearer: bearer, client: client}
}

func (s Client) request(ctx context.Context, method, path, owner, key string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, s.origin+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.bearer)
	req.Header.Set("X-Bento-Owner-Id", owner)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	return s.client.Do(req)
}
