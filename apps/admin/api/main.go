package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

type grant struct {
	Subject, Owner, Workspace string
}

type session struct {
	subject, csrf string
	expires       time.Time
}

type diagnosticRun struct {
	ID, Status string
}

var uuid = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func required(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatal("missing ", name)
	}
	return value
}

func cookie(w http.ResponseWriter, name, value, path string, age int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: path, MaxAge: age,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode})
}

func cookieValue(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return c.Value
}

func rejectRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

func secureIdentityURL(raw string) bool {
	address, err := url.Parse(raw)
	return err == nil && address.Scheme == "https" && address.Host != "" &&
		address.User == nil && address.Fragment == ""
}

func main() {
	issuer := required("BENTO_ADMIN_OIDC_ISSUER")
	origin := required("BENTO_ADMIN_PUBLIC_ORIGIN")
	public, err := url.Parse(origin)
	if err != nil || public.Scheme != "https" || public.Host == "" || public.User != nil ||
		public.Path != "" || public.RawQuery != "" || public.Fragment != "" {
		log.Fatal("admin origin must be an HTTPS origin")
	}
	identityClient := &http.Client{Timeout: 10 * time.Second, CheckRedirect: rejectRedirect}
	if !secureIdentityURL(issuer) {
		log.Fatal("admin issuer must use HTTPS")
	}
	identityContext := oidc.ClientContext(context.Background(), identityClient)
	provider, err := oidc.NewProvider(identityContext, issuer)
	if err != nil {
		log.Fatal("admin OIDC discovery failed")
	}
	auth := oauth2.Config{
		ClientID: required("BENTO_ADMIN_OIDC_CLIENT"), ClientSecret: required("BENTO_ADMIN_OIDC_SECRET"),
		RedirectURL: origin + "/auth/callback", Endpoint: provider.Endpoint(), Scopes: []string{oidc.ScopeOpenID},
	}
	var metadata struct {
		Keys string `json:"jwks_uri"`
	}
	if provider.Claims(&metadata) != nil || !secureIdentityURL(metadata.Keys) ||
		!secureIdentityURL(auth.Endpoint.AuthURL) || !secureIdentityURL(auth.Endpoint.TokenURL) {
		log.Fatal("admin identity endpoints must use HTTPS")
	}
	verifier := provider.Verifier(&oidc.Config{ClientID: auth.ClientID})
	execution := strings.TrimRight(required("BENTO_EXECUTION_ORIGIN"), "/")
	bearer := required("BENTO_ADMIN_SERVICE_BEARER")
	var grants []grant
	if json.Unmarshal([]byte(required("BENTO_ADMIN_WORKSPACE_GRANTS")), &grants) != nil || grants == nil {
		log.Fatal("invalid admin Workspace grants")
	}
	assets := required("BENTO_ADMIN_ASSET_ROOT")
	page := template.Must(template.ParseFiles(assets + "/web/index.html"))
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: rejectRedirect}
	var sessions sync.Map
	mux := http.NewServeMux()
	mux.HandleFunc("GET /auth/login", func(w http.ResponseWriter, r *http.Request) {
		state, code := rand.Text(), oauth2.GenerateVerifier()
		cookie(w, "__Host-bento_admin_login", state+"."+code, "/", 300)
		http.Redirect(w, r, auth.AuthCodeURL(state, oauth2.S256ChallengeOption(code), oidc.Nonce(state)), http.StatusFound)
	})
	mux.HandleFunc("GET /auth/callback", func(w http.ResponseWriter, r *http.Request) {
		state, code, ok := strings.Cut(cookieValue(r, "__Host-bento_admin_login"), ".")
		cookie(w, "__Host-bento_admin_login", "", "/", -1)
		if !ok || state != r.URL.Query().Get("state") || r.URL.Query().Get("code") == "" {
			http.Error(w, "登录请求无效", 400)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		token, err := auth.Exchange(oidc.ClientContext(ctx, identityClient), r.URL.Query().Get("code"), oauth2.VerifierOption(code))
		if err != nil {
			http.Error(w, "认证失败", 401)
			return
		}
		raw, _ := token.Extra("id_token").(string)
		id, err := verifier.Verify(ctx, raw)
		if err != nil || id.Nonce != state || id.Subject == "" {
			http.Error(w, "认证失败", 401)
			return
		}
		if !slices.ContainsFunc(grants, func(g grant) bool { return g.Subject == id.Subject }) {
			http.Error(w, "当前账号没有 Workspace 授权", 403)
			return
		}
		now := time.Now()
		sessions.Range(func(key, value any) bool {
			if !now.Before(value.(session).expires) {
				sessions.Delete(key)
			}
			return true
		})
		sessions.Delete(cookieValue(r, "__Host-bento_admin"))
		sid := rand.Text()
		sessions.Store(sid, session{id.Subject, rand.Text(), now.Add(30 * time.Minute)})
		cookie(w, "__Host-bento_admin", sid, "/", 1800)
		http.Redirect(w, r, "/", http.StatusSeeOther)
	})
	invoke := func(r *http.Request, s session, workspace, id, key string) (diagnosticRun, int) {
		var result diagnosticRun
		if !slices.ContainsFunc(grants, func(g grant) bool { return g.Subject == s.subject && g.Workspace == workspace }) {
			return result, http.StatusForbidden
		}
		path := execution + "/v1/admin/workspaces/" + url.PathEscape(workspace) + "/diagnostic-runs"
		if id != "" {
			path += "/" + url.PathEscape(id)
		}
		req, err := http.NewRequestWithContext(r.Context(), r.Method, path, nil)
		if err != nil {
			return result, 502
		}
		req.Header.Set("Authorization", "Bearer "+bearer)
		req.Header.Set("X-Bento-Admin-Subject", s.subject)
		req.Header.Set("Idempotency-Key", key)
		response, err := client.Do(req)
		if err != nil {
			return result, 502
		}
		defer response.Body.Close()
		switch response.StatusCode {
		case 200, 202:
			if json.NewDecoder(response.Body).Decode(&result) != nil || !uuid.MatchString(result.ID) {
				return result, 502
			}
			return result, 200
		case 400, 403, 404, 409, 429:
			return result, response.StatusCode
		default:
			return result, 502
		}
	}
	withSession := func(r *http.Request) (session, bool) {
		id := cookieValue(r, "__Host-bento_admin")
		value, ok := sessions.Load(id)
		if ok {
			s := value.(session)
			if time.Now().Before(s.expires) {
				return s, true
			}
			sessions.Delete(id)
		}
		return session{}, false
	}
	render := func(w http.ResponseWriter, s session, run *diagnosticRun) {
		workspaces := []string{}
		for _, g := range grants {
			if g.Subject == s.subject && !slices.Contains(workspaces, g.Workspace) {
				workspaces = append(workspaces, g.Workspace)
			}
		}
		// UUIDv4 is the diagnostic submission idempotency key.
		b := make([]byte, 16)
		rand.Read(b)
		b[6] = b[6]&0x0f | 0x40
		b[8] = b[8]&0x3f | 0x80
		key := fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
		if err := page.Execute(w, struct {
			Workspaces []string
			CSRF, Key  string
			Run        *diagnosticRun
		}{workspaces, s.csrf, key, run}); err != nil {
			log.Print("admin page rendering failed")
		}
	}
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		s, ok := withSession(r)
		if !ok {
			http.ServeFile(w, r, assets+"/auth/login.html")
			return
		}
		render(w, s, nil)
	})
	mux.HandleFunc("POST /diagnostics", func(w http.ResponseWriter, r *http.Request) {
		s, ok := withSession(r)
		if !ok {
			http.Error(w, "请先登录", 401)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if r.ParseForm() != nil || r.PostForm.Get("csrf") != s.csrf {
			http.Error(w, "提交无效", 403)
			return
		}
		workspace, key := r.PostForm.Get("workspace"), r.PostForm.Get("key")
		if !uuid.MatchString(workspace) || !uuid.MatchString(key) {
			http.Error(w, "提交无效", 400)
			return
		}
		run, status := invoke(r, s, workspace, "", key)
		if status != 200 {
			http.Error(w, "诊断提交失败", status)
			return
		}
		http.Redirect(w, r, "/diagnostics/"+workspace+"/"+run.ID, http.StatusSeeOther)
	})
	mux.HandleFunc("GET /diagnostics/{workspace}/{run}", func(w http.ResponseWriter, r *http.Request) {
		s, ok := withSession(r)
		if !ok {
			http.Error(w, "请先登录", 401)
			return
		}
		workspace, id := r.PathValue("workspace"), r.PathValue("run")
		if !uuid.MatchString(workspace) || !uuid.MatchString(id) {
			http.NotFound(w, r)
			return
		}
		run, status := invoke(r, s, workspace, id, "")
		if status != 200 {
			http.Error(w, "诊断状态查询失败", status)
			return
		}
		render(w, s, &run)
	})
	server := &http.Server{Addr: required("BENTO_ADMIN_LISTEN"), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
			mux.ServeHTTP(w, r)
		}),
	}
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
