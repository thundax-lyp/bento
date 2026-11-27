package auth

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/httpx"
)

func NewStore(db *sql.DB) Store { return Store{db: db} }

type Options struct {
	Origin, Issuer, ClientID, ClientSecret, Organization string
	AssetsDir, SpaceOrigin                               string
	SpaceRequired, Secure                                bool
}

func Register(ctx context.Context, mux *http.ServeMux, store Store, opt Options) (*Sessions, error) {
	sessions := newWebSessions(store, opt.Secure, opt.Issuer != "")
	password := newPasswordAuth(store, sessions, opt.Origin, opt.SpaceRequired)
	if opt.Issuer == "" {
		password.routes(mux)
		return sessions, nil
	}
	identity, err := newKeycloak(ctx, oidcOptions{
		origin: opt.Origin, issuer: opt.Issuer, clientID: opt.ClientID, clientSecret: opt.ClientSecret, organization: opt.Organization,
		assetsDir: opt.AssetsDir, spaceOrigin: opt.SpaceOrigin, spaceRequired: opt.SpaceRequired,
	}, store, sessions)
	if err != nil {
		if errors.Is(err, errAuthArtifacts) {
			return nil, errAuthArtifacts
		}
		return nil, errors.New("could not initialize Workspace OIDC")
	}
	identity.routes(mux)
	password.sessionRoutes(mux)
	for _, path := range []string{"/api/login", "/api/register", "/api/account/close", "/api/oidc/"} {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "POST" && (len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != opt.Origin) {
				httpx.Fail(w, httpx.NewError(400, "invalid_origin", "请从任务入口提交请求。"))
				return
			}
			httpx.Fail(w, httpx.NotFound)
		})
	}
	return sessions, nil
}
