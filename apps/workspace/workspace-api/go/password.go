package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/scrypt"
)

type passwordAccounts interface {
	accountReader
	accountByName(context.Context, string) (account, error)
	registerPassword(context.Context, string, []byte, []byte) (bool, error)
	deactivate(context.Context, string, bool) (bool, error)
}

type loginAttempt struct {
	count   int
	expires time.Time
}

type passwordAuth struct {
	accounts      passwordAccounts
	sessions      *webSessions
	origin        string
	spaceRequired bool
	hashSlots     chan struct{}
	mu            sync.Mutex
	attempts      map[string]loginAttempt
}

func newPasswordAuth(store passwordAccounts, sessions *webSessions, origin string, spaceRequired bool) *passwordAuth {
	return &passwordAuth{
		accounts: store, sessions: sessions, origin: origin, spaceRequired: spaceRequired,
		hashSlots: make(chan struct{}, 2), attempts: make(map[string]loginAttempt),
	}
}

type requestFailure struct {
	status  int
	code    string
	message string
}

var (
	invalidCredentials = &requestFailure{401, "invalid_credentials", "账号或登录凭据不正确。"}
	invalidInvite      = &requestFailure{401, "invalid_invite", "账号或邀请码不正确。"}
	alreadyRegistered  = &requestFailure{409, "already_registered", "账号已注册，请登录。"}
	invalidPassword    = &requestFailure{400, "invalid_password", "请设置 15 至 128 个字符的密码，与邀请码不同。"}
	authBusy           = &requestFailure{429, "auth_busy", "认证请求较多，请稍后重试。"}
	loginLimited       = &requestFailure{429, "login_limited", "登录尝试过多，请稍后重试。"}
	accountName        = regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,128}$`)
)

func (f *requestFailure) Error() string { return f.code }

func authFailure(w http.ResponseWriter, err error) {
	failure := &requestFailure{500, "server_error", "任务入口暂不可用，请稍后重试。"}
	switch {
	case errors.Is(err, errLoginRequired):
		failure = &requestFailure{401, "login_required", "请使用受邀账号登录。"}
	default:
		var known *requestFailure
		if errors.As(err, &known) {
			failure = known
		}
	}
	authJSON(w, failure.status, map[string]any{"error": map[string]string{
		"code": failure.code, "message": failure.message,
	}})
}

func authJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

type credentials struct {
	Account   string `json:"account"`
	Password  string `json:"password"`
	Invite    string `json:"invite"`
	Confirmed bool   `json:"confirmed"`
}

func readCredentials(w http.ResponseWriter, r *http.Request) (credentials, error) {
	var input credentials
	media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if media != "application/json" {
		return input, &requestFailure{400, "invalid_content_type", "请使用 application/json。"}
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	var limit *http.MaxBytesError
	if errors.As(err, &limit) {
		return input, &requestFailure{413, "too_large", "请求超过大小限制。"}
	}
	if err != nil || !utf8.Valid(body) || !strings.HasPrefix(strings.TrimSpace(string(body)), "{") ||
		json.Unmarshal(body, &input) != nil {
		return input, &requestFailure{400, "invalid_json", "请求内容必须是 UTF-8 JSON。"}
	}
	return input, nil
}

func (a *passwordAuth) invited(ctx context.Context, name string, failure error) (account, error) {
	name = strings.TrimSpace(name)
	if !accountName.MatchString(name) {
		return account{}, failure
	}
	row, err := a.accounts.accountByName(ctx, name)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && row.Closed) {
		return account{}, failure
	}
	return row, err
}

func matchesInvite(row account, invite string) bool {
	if len(invite) > 1024 {
		return false
	}
	saved, err := hex.DecodeString(row.InviteHash)
	if err != nil {
		return false
	}
	digest := sha256.Sum256([]byte(invite))
	return subtle.ConstantTimeCompare(saved, digest[:]) == 1
}

func (a *passwordAuth) derive(password string, salt []byte) ([]byte, error) {
	select {
	case a.hashSlots <- struct{}{}:
		defer func() { <-a.hashSlots }()
	default:
		return nil, authBusy
	}
	return scrypt.Key([]byte(password), salt, 32768, 8, 3, 32)
}

func (a *passwordAuth) attempt(owner string, now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for key, previous := range a.attempts {
		if !previous.expires.After(now) {
			delete(a.attempts, key)
		}
	}
	previous := a.attempts[owner]
	if previous.count >= 10 {
		return false
	}
	if previous.count == 0 {
		previous.expires = now.Add(time.Minute)
	}
	previous.count++
	a.attempts[owner] = previous
	return true
}

func (a *passwordAuth) verify(row account, password string) error {
	if row.Closed || len(row.Salt) != 16 || len(row.Hash) != 32 ||
		password == "" || utf8.RuneCountInString(password) > 128 {
		return invalidCredentials
	}
	if !a.attempt(row.Owner, time.Now()) {
		return loginLimited
	}
	hash, err := a.derive(password, row.Salt)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare(hash, row.Hash) != 1 {
		return invalidCredentials
	}
	a.mu.Lock()
	delete(a.attempts, row.Owner)
	a.mu.Unlock()
	return nil
}

func (a *passwordAuth) register(ctx context.Context, input credentials) (account, error) {
	row, err := a.invited(ctx, input.Account, invalidInvite)
	if err != nil {
		return account{}, err
	}
	if !matchesInvite(row, input.Invite) {
		return account{}, invalidInvite
	}
	if len(row.Hash) > 0 {
		return account{}, alreadyRegistered
	}
	length := utf8.RuneCountInString(input.Password)
	if length < 15 || length > 128 || matchesInvite(row, input.Password) {
		return account{}, invalidPassword
	}
	var salt [16]byte
	if _, err := rand.Read(salt[:]); err != nil {
		return account{}, err
	}
	hash, err := a.derive(input.Password, salt[:])
	if err != nil {
		return account{}, err
	}
	ok, err := a.accounts.registerPassword(ctx, row.Owner, salt[:], hash)
	if err == nil && !ok {
		err = alreadyRegistered
	}
	return row, err
}

func (a *passwordAuth) login(w http.ResponseWriter, r *http.Request, input credentials) error {
	row, err := a.invited(r.Context(), input.Account, invalidCredentials)
	if err != nil {
		return err
	}
	if err := a.verify(row, input.Password); err != nil {
		return err
	}
	current, err := a.accounts.accountByOwner(r.Context(), row.Owner)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && current.Closed) {
		return invalidCredentials
	}
	if err != nil {
		return err
	}
	cookie, err := a.sessions.start(r, row)
	if err != nil {
		return err
	}
	http.SetCookie(w, cookie)
	authJSON(w, 200, map[string]string{"account": row.Name})
	return nil
}

func (a *passwordAuth) close(w http.ResponseWriter, r *http.Request, input credentials) error {
	saved, err := a.sessions.current(r)
	if err != nil {
		return err
	}
	if !input.Confirmed {
		return &requestFailure{400, "confirmation_required", "请先确认注销账号的影响。"}
	}
	row, err := a.accounts.accountByOwner(r.Context(), saved.Owner)
	if errors.Is(err, sql.ErrNoRows) {
		return invalidCredentials
	}
	if err != nil {
		return err
	}
	if err := a.verify(row, input.Password); err != nil {
		return err
	}
	if current, err := a.sessions.current(r); err != nil || current != saved {
		if err != nil {
			return err
		}
		return invalidCredentials
	}
	ok, err := a.accounts.deactivate(r.Context(), row.Owner, a.spaceRequired)
	if err != nil {
		return err
	}
	if !ok {
		return invalidCredentials
	}
	a.sessions.revokeOwner(row.Owner)
	http.SetCookie(w, a.sessions.logout(r))
	authJSON(w, 200, struct{}{})
	return nil
}

func registerSessionRoute(mux *http.ServeMux, sessions *webSessions) {
	mux.HandleFunc("GET /api/session", func(w http.ResponseWriter, r *http.Request) {
		saved, err := sessions.current(r)
		if err != nil {
			authFailure(w, err)
			return
		}
		authJSON(w, 200, map[string]string{"account": saved.Name})
	})
}

func (a *passwordAuth) routes(mux *http.ServeMux) {
	registerSessionRoute(mux, a.sessions)
	mux.HandleFunc("POST /api/logout", a.post(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, a.sessions.logout(r))
		authJSON(w, 200, struct{}{})
	}))
	mux.HandleFunc("POST /api/register", a.withCredentials(func(w http.ResponseWriter, r *http.Request, input credentials) error {
		row, err := a.register(r.Context(), input)
		if err == nil {
			authJSON(w, 201, map[string]string{"account": row.Name})
		}
		return err
	}))
	mux.HandleFunc("POST /api/login", a.withCredentials(a.login))
	mux.HandleFunc("POST /api/account/close", a.withCredentials(a.close))
}

func (a *passwordAuth) post(handle http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != a.origin || len(r.Header.Values("Origin")) != 1 {
			authFailure(w, &requestFailure{400, "invalid_origin", "请从任务入口提交请求。"})
			return
		}
		handle(w, r)
	}
}

func (a *passwordAuth) withCredentials(handle func(http.ResponseWriter, *http.Request, credentials) error) http.HandlerFunc {
	return a.post(func(w http.ResponseWriter, r *http.Request) {
		input, err := readCredentials(w, r)
		if err == nil {
			err = handle(w, r, input)
		}
		if err != nil {
			authFailure(w, err)
		}
	})
}
