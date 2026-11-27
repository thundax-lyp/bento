package api

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/auth"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/httpx"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/orchestrator"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/space"
)

func Register(ctx context.Context, public *http.ServeMux, store auth.Store, backend orchestrator.Client) (func(), error) {
	var workspaceSpace *space.Service
	origin := strings.TrimSuffix(os.Getenv("BENTO_ONE_ORIGIN"), "/")
	if origin == "" {
		origin = "http://127.0.0.1:4102"
	}
	publicURL, err := httpx.SecureURL(origin, true)
	if err != nil || publicURL.Path != "" || publicURL.RawQuery != "" {
		return nil, errors.New("invalid Workspace origin")
	}
	issuer := os.Getenv("BENTO_OIDC_ISSUER")
	if issuer == "" && os.Getenv("BENTO_AUTH_MODE") == "keycloak" {
		return nil, errors.New("Keycloak issuer is required")
	}
	database, endpoint, bucket := os.Getenv("BENTO_SPACE_DB"), os.Getenv("BENTO_SPACE_S3_ENDPOINT"), os.Getenv("BENTO_SPACE_S3_BUCKET")
	spaceOrigin := strings.TrimSuffix(endpoint, "/")
	sessions, err := auth.Register(ctx, public, store, auth.Options{
		Origin: origin, Issuer: issuer, ClientID: os.Getenv("BENTO_OIDC_CLIENT_ID"),
		ClientSecret: os.Getenv("BENTO_OIDC_CLIENT_SECRET"), Organization: os.Getenv("BENTO_OIDC_ORGANIZATION"),
		SpaceRequired: endpoint != "", Secure: publicURL.Scheme == "https", AssetsDir: "apps/workspace/workspace-auth/dist",
		SpaceOrigin: spaceOrigin,
	})
	if err != nil {
		return nil, err
	}
	headers := func(w http.ResponseWriter) { httpx.SecurityHeaders(w, spaceOrigin) }
	router := projectRoutes{backend, headers}
	router.registerProjects(public, sessions.Current, origin)
	if database != "" || endpoint != "" || bucket != "" {
		if database == "" || database == ":memory:" || endpoint == "" || bucket == "" {
			return nil, errors.New("incomplete space configuration")
		}
		endpointURL, err := httpx.SecureURL(spaceOrigin, httpx.Loopback(publicURL.Hostname()))
		if err != nil || endpointURL.Path != "" || endpointURL.RawQuery != "" ||
			(!httpx.Loopback(publicURL.Hostname()) && endpointURL.Hostname() == publicURL.Hostname()) {
			return nil, errors.New("invalid Workspace object storage origin")
		}
		workspaceSpace, err = space.Open(ctx, public, sessions.Current, headers, backend, space.Config{
			Origin: origin, Database: database, Endpoint: spaceOrigin, Bucket: bucket, Region: os.Getenv("AWS_REGION"),
		})
		if err != nil {
			return nil, err
		}
	}
	router.registerTasks(public, sessions.Current, origin, workspaceSpace)
	public.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		headers(w)
		if r.Method == http.MethodPost && (len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != origin) {
			httpx.Fail(w, httpx.NewError(400, "invalid_origin", "请从任务入口提交请求。"))
			return
		}
		if _, err := sessions.Current(r); err != nil {
			httpx.Fail(w, err)
			return
		}
		httpx.Fail(w, httpx.NotFound)
	})
	public.HandleFunc("/auth/", func(w http.ResponseWriter, r *http.Request) { httpx.Fail(w, httpx.NotFound) })
	stopSweep := (accountSweep{store: store, backend: backend, space: workspaceSpace}).start(ctx)
	return func() {
		stopSweep()
		if workspaceSpace != nil {
			workspaceSpace.Close()
		}
	}, nil
}
