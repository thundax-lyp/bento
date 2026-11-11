package main

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

//go:embed auth.html
var loginHTML string

//go:embed auth.css
var loginCSS string

var loginPage = template.Must(template.New("login").Parse(loginHTML))

const oidcLifetime = 5 * time.Minute

var oidcDenied = &requestFailure{401, "oidc_denied", "此身份没有有效的 Bento 邀请，请从登录页重试。"}

type externalSession struct {
	subject string
	idToken string
}

type oidcAccounts interface {
	linkIdentity(context.Context, oidcIdentity) (account, error)
	deactivate(context.Context, string, bool) (bool, error)
}

type oidcOptions struct {
	origin, issuer, clientID, clientSecret, organization string
	spaceRequired                                        bool
}

type loginTransaction struct {
	state, nonce, verifier string
	started, expires       time.Time
	closing                *webSession
}

type keycloak struct {
	options      oidcOptions
	store        oidcAccounts
	sessions     *webSessions
	config       oauth2.Config
	verifier     *oidc.IDTokenVerifier
	client       *http.Client
	logoutURL    *url.URL
	cookieName   string
	mu           sync.Mutex
	transactions map[[32]byte]loginTransaction
}

func secureOIDCURL(raw string, local bool) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return nil, errors.New("invalid Keycloak URL")
	}
	if u.Scheme == "https" || (local && u.Scheme == "http" && loopback(u.Hostname())) {
		return u, nil
	}
	return nil, errors.New("Keycloak URLs require HTTPS")
}

func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func newKeycloak(ctx context.Context, options oidcOptions, store oidcAccounts, sessions *webSessions) (*keycloak, error) {
	origin, err := secureOIDCURL(options.origin, true)
	if err != nil || origin.Path != "" || origin.RawQuery != "" ||
		options.clientID == "" || options.clientSecret == "" || options.organization == "" {
		return nil, errors.New("invalid Keycloak settings")
	}
	local := origin.Scheme == "http" && loopback(origin.Hostname())
	issuer, err := secureOIDCURL(options.issuer, local)
	if err != nil || issuer.RawQuery != "" {
		return nil, errors.New("invalid Keycloak issuer")
	}
	client := &http.Client{
		Timeout:       8 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
	ctx = oidc.ClientContext(ctx, client)
	provider, err := oidc.NewProvider(ctx, options.issuer)
	if err != nil {
		return nil, err
	}
	var metadata struct {
		Logout string `json:"end_session_endpoint"`
		JWKS   string `json:"jwks_uri"`
	}
	if err := provider.Claims(&metadata); err != nil {
		return nil, err
	}
	endpoint := provider.Endpoint()
	allowHTTP := local && issuer.Scheme == "http"
	for _, raw := range []string{endpoint.AuthURL, endpoint.TokenURL, metadata.JWKS} {
		if _, err := secureOIDCURL(raw, allowHTTP); err != nil {
			return nil, err
		}
	}
	logout, err := secureOIDCURL(metadata.Logout, allowHTTP)
	if err != nil {
		return nil, err
	}
	name := "bento_oidc"
	if sessions.secure {
		name = "__Host-bento_oidc"
	}
	return &keycloak{
		options: options, store: store, sessions: sessions, client: client, logoutURL: logout, cookieName: name,
		config: oauth2.Config{
			ClientID: options.clientID, ClientSecret: options.clientSecret, Endpoint: endpoint,
			RedirectURL: options.origin + "/api/oidc/callback", Scopes: []string{"openid", "email", "organization:*"},
		},
		verifier:     provider.Verifier(&oidc.Config{ClientID: options.clientID}),
		transactions: make(map[[32]byte]loginTransaction),
	}, nil
}

func (k *keycloak) cookie(value string, age int) *http.Cookie {
	return &http.Cookie{Name: k.cookieName, Value: value, MaxAge: age, Path: "/", HttpOnly: true,
		Secure: k.sessions.secure, SameSite: http.SameSiteLaxMode}
}

func (k *keycloak) key(r *http.Request) ([32]byte, bool) {
	cookies := r.CookiesNamed(k.cookieName)
	if len(cookies) != 1 || len(cookies[0].Value) != 43 {
		return [32]byte{}, false
	}
	return sha256.Sum256([]byte(cookies[0].Value)), true
}

func (k *keycloak) start(w http.ResponseWriter, r *http.Request, closing *webSession) error {
	token := oauth2.GenerateVerifier()
	now := time.Now()
	tx := loginTransaction{
		state: oauth2.GenerateVerifier(), nonce: oauth2.GenerateVerifier(), verifier: oauth2.GenerateVerifier(),
		started: now, expires: now.Add(oidcLifetime), closing: closing,
	}
	k.mu.Lock()
	if old, ok := k.key(r); ok {
		delete(k.transactions, old)
	}
	for key, tx := range k.transactions {
		if !tx.expires.After(now) {
			delete(k.transactions, key)
		}
	}
	if len(k.transactions) >= 2048 {
		k.mu.Unlock()
		return &requestFailure{503, "auth_busy", "登录请求较多，请稍后重试。"}
	}
	k.transactions[sha256.Sum256([]byte(token))] = tx
	k.mu.Unlock()

	opts := []oauth2.AuthCodeOption{oidc.Nonce(tx.nonce), oauth2.S256ChallengeOption(tx.verifier)}
	if closing != nil {
		opts = append(opts, oauth2.SetAuthURLParam("max_age", "0"), oauth2.SetAuthURLParam("prompt", "login"))
	}
	http.SetCookie(w, k.cookie(token, int(oidcLifetime/time.Second)))
	redirect(w, k.config.AuthCodeURL(tx.state, opts...))
	return nil
}

func (k *keycloak) transaction(r *http.Request) (loginTransaction, bool) {
	key, ok := k.key(r)
	states := r.URL.Query()["state"]
	if !ok || len(states) != 1 {
		return loginTransaction{}, false
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	tx, ok := k.transactions[key]
	if !ok || !tx.expires.After(time.Now()) || tx.state != states[0] {
		return loginTransaction{}, false
	}
	delete(k.transactions, key)
	return tx, true
}

func memberOf(raw json.RawMessage, organization string) bool {
	var list []string
	if json.Unmarshal(raw, &list) == nil {
		for _, name := range list {
			if name == organization {
				return true
			}
		}
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) == nil {
		_, exists := object[organization]
		return exists
	}
	return false
}

func (k *keycloak) callback(w http.ResponseWriter, r *http.Request) error {
	tx, ok := k.transaction(r)
	if !ok {
		return oidcDenied
	}
	http.SetCookie(w, k.cookie("", -1))
	query := r.URL.Query()
	codes := query["code"]
	if len(codes) != 1 || codes[0] == "" || query.Has("error") ||
		(query.Has("iss") && (len(query["iss"]) != 1 || query.Get("iss") != k.options.issuer)) {
		return oidcDenied
	}
	ctx := oidc.ClientContext(r.Context(), k.client)
	tokens, err := k.config.Exchange(ctx, codes[0], oauth2.VerifierOption(tx.verifier))
	if err != nil {
		return oidcDenied
	}
	raw, ok := tokens.Extra("id_token").(string)
	if !ok || raw == "" {
		return oidcDenied
	}
	token, err := k.verifier.Verify(ctx, raw)
	if err != nil || token.Nonce != tx.nonce ||
		(token.AccessTokenHash != "" && token.VerifyAccessToken(tokens.AccessToken) != nil) {
		return oidcDenied
	}
	var claims struct {
		Email           string          `json:"email"`
		Verified        bool            `json:"email_verified"`
		Organizations   json.RawMessage `json:"organization"`
		AuthorizedParty string          `json:"azp"`
		AuthTime        int64           `json:"auth_time"`
	}
	if err := token.Claims(&claims); err != nil || !claims.Verified ||
		!memberOf(claims.Organizations, k.options.organization) ||
		((len(token.Audience) > 1 || claims.AuthorizedParty != "") && claims.AuthorizedParty != k.options.clientID) {
		return oidcDenied
	}

	if tx.closing != nil {
		saved, err := k.sessions.current(r)
		authTime := time.Unix(claims.AuthTime, 0)
		if err != nil || saved != tx.closing || saved.Identity == nil || saved.Identity.subject != token.Subject ||
			authTime.Before(tx.started.Add(-5*time.Second)) || authTime.After(time.Now().Add(5*time.Second)) {
			return oidcDenied
		}
	}
	identity := oidcIdentity{Issuer: token.Issuer, Subject: token.Subject, Account: claims.Email}
	if !identity.valid() {
		return oidcDenied
	}
	row, err := k.store.linkIdentity(ctx, identity)
	if err != nil {
		return err
	}
	if row.Closed {
		return oidcDenied
	}
	if tx.closing == nil {
		cookie, err := k.sessions.startIdentity(r, row, &externalSession{subject: token.Subject, idToken: raw})
		if err != nil {
			return err
		}
		http.SetCookie(w, cookie)
		redirect(w, "/")
		return nil
	}
	if row.Owner != tx.closing.Owner {
		return oidcDenied
	}
	closed, err := k.store.deactivate(ctx, row.Owner, k.options.spaceRequired)
	if err != nil {
		return err
	}
	if !closed {
		return oidcDenied
	}
	k.sessions.revokeOwner(row.Owner)
	http.SetCookie(w, k.sessions.logout(r))
	redirect(w, k.endSession(raw))
	return nil
}

func (k *keycloak) endSession(idToken string) string {
	u := *k.logoutURL
	query := u.Query()
	query.Set("id_token_hint", idToken)
	query.Set("post_logout_redirect_uri", k.options.origin+"/auth")
	u.RawQuery = query.Encode()
	return u.String()
}

func redirect(w http.ResponseWriter, target string) {
	w.Header().Set("Location", target)
	w.WriteHeader(http.StatusSeeOther)
}

func (k *keycloak) routes(mux *http.ServeMux) {
	register := func(pattern string, handle func(http.ResponseWriter, *http.Request) error) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Referrer-Policy", "no-referrer")
			if r.Method == "POST" && (len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != k.options.origin) {
				authFailure(w, &requestFailure{400, "invalid_origin", "请从任务入口提交请求。"})
				return
			}
			if err := handle(w, r); err != nil {
				authFailure(w, err)
			}
		})
	}
	register("GET /auth", func(w http.ResponseWriter, r *http.Request) error {
		w.Header().Set("Referrer-Policy", "same-origin")
		_, err := k.sessions.current(r)
		if err != nil && !errors.Is(err, errLoginRequired) {
			return err
		}
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' "+k.logoutURL.Scheme+"://"+k.logoutURL.Host)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_ = loginPage.Execute(w, err == nil)
		return nil
	})
	register("GET /auth/style.css", func(w http.ResponseWriter, _ *http.Request) error {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = io.WriteString(w, loginCSS)
		return nil
	})
	register("GET /api/oidc/start", func(w http.ResponseWriter, r *http.Request) error { return k.start(w, r, nil) })
	register("GET /api/oidc/callback", k.callback)
	register("POST /api/oidc/logout", func(w http.ResponseWriter, r *http.Request) error {
		session, err := k.sessions.current(r)
		if err != nil {
			return err
		}
		if session.Identity == nil {
			return oidcDenied
		}
		http.SetCookie(w, k.sessions.logout(r))
		redirect(w, k.endSession(session.Identity.idToken))
		return nil
	})
	register("POST /api/oidc/close", func(w http.ResponseWriter, r *http.Request) error {
		session, err := k.sessions.current(r)
		if err != nil {
			return err
		}
		if session.Identity == nil {
			return oidcDenied
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 128))
		if err != nil || strings.TrimSpace(string(body)) != "confirmed=yes" {
			return oidcDenied
		}
		return k.start(w, r, session)
	})
}
