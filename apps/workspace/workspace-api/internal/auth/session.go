package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/internal/httpx"
	"net/http"
	"sync"
	"time"
)

const sessionLifetime = 24 * time.Hour

type accountReader interface {
	accountByOwner(context.Context, string) (account, error)
}

type Session struct {
	Owner    string
	Name     string
	Expires  time.Time
	Identity *externalSession
}

type Sessions struct {
	accounts accountReader
	name     string
	secure   bool
	sameSite http.SameSite
	mu       sync.Mutex
	sessions map[[32]byte]*Session
}

func newWebSessions(accounts accountReader, secure, oidc bool) *Sessions {
	s := &Sessions{
		accounts: accounts,
		name:     "bento_one",
		secure:   secure,
		sameSite: http.SameSiteStrictMode,
		sessions: make(map[[32]byte]*Session),
	}
	if secure {
		s.name = "__Host-bento_one"
	}
	if oidc {
		s.sameSite = http.SameSiteLaxMode
	}
	return s
}

func (s *Sessions) cookie(token string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name: s.name, Value: token, Path: "/", HttpOnly: true,
		Secure: s.secure, SameSite: s.sameSite, MaxAge: maxAge,
	}
}

func (s *Sessions) key(r *http.Request) ([32]byte, bool) {
	cookies := r.CookiesNamed(s.name)
	if len(cookies) != 1 || len(cookies[0].Value) != 43 {
		return [32]byte{}, false
	}
	token := cookies[0].Value
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(token)
	if err != nil || len(decoded) != 32 {
		return [32]byte{}, false
	}
	return sha256.Sum256([]byte(token)), true
}

func (s *Sessions) start(r *http.Request, identity account) (*http.Cookie, error) {
	return s.startIdentity(r, identity, nil)
}

func (s *Sessions) startIdentity(r *http.Request, identity account, external *externalSession) (*http.Cookie, error) {
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(random[:])
	key := sha256.Sum256([]byte(token))
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, saved := range s.sessions {
		if !saved.Expires.After(now) {
			delete(s.sessions, key)
		}
	}
	if old, ok := s.key(r); ok {
		delete(s.sessions, old)
	}
	s.sessions[key] = &Session{Owner: identity.Owner, Name: identity.Name, Expires: now.Add(sessionLifetime), Identity: external}
	return s.cookie(token, int(sessionLifetime/time.Second)), nil
}

func (s *Sessions) Current(r *http.Request) (*Session, error) {
	key, ok := s.key(r)
	if !ok {
		return nil, httpx.ErrLoginRequired
	}
	s.mu.Lock()
	saved := s.sessions[key]
	if saved == nil || !saved.Expires.After(time.Now()) {
		delete(s.sessions, key)
		s.mu.Unlock()
		return nil, httpx.ErrLoginRequired
	}
	s.mu.Unlock()

	current, err := s.accounts.accountByOwner(r.Context(), saved.Owner)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil || current.Closed || s.sessions[key] != saved || !saved.Expires.After(time.Now()) {
		delete(s.sessions, key)
		return nil, httpx.ErrLoginRequired
	}
	return saved, nil
}

func (s *Sessions) logout(r *http.Request) *http.Cookie {
	if key, ok := s.key(r); ok {
		s.mu.Lock()
		delete(s.sessions, key)
		s.mu.Unlock()
	}
	return s.cookie("", -1)
}

func (s *Sessions) revokeOwner(owner string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, saved := range s.sessions {
		if saved.Owner == owner {
			delete(s.sessions, key)
		}
	}
}
