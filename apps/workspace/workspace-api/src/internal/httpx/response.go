package httpx

import (
	"encoding/json"
	"errors"
	"net/http"
)

type Error struct {
	Status  int
	Code    string
	Message string
}

func NewError(status int, code, message string) *Error {
	return &Error{status, code, message}
}

func (f *Error) Error() string { return f.Code }

var (
	ErrLoginRequired   = errors.New("login required")
	NotFound           = NewError(404, "not_found", "找不到该资源。")
	InvalidTask        = NewError(400, "invalid_input", "任务请求内容无效。")
	BackendUnavailable = NewError(502, "backend_error", "任务服务暂不可用，请稍后重试。")
)

func Fail(w http.ResponseWriter, err error) {
	var details interface{ HTTPDetails() (*Error, any) }
	if errors.As(err, &details) {
		failure, issues := details.HTTPDetails()
		body := map[string]any{"code": failure.Code, "message": failure.Message}
		if issues != nil {
			body["issues"] = issues
		}
		JSON(w, failure.Status, map[string]any{"error": body})
		return
	}
	failure := NewError(500, "server_error", "任务入口暂不可用，请稍后重试。")
	if errors.Is(err, ErrLoginRequired) {
		failure = NewError(401, "login_required", "请使用受邀账号登录。")
	} else {
		var known *Error
		if errors.As(err, &known) {
			failure = known
		}
	}
	JSON(w, failure.Status, map[string]any{"error": map[string]string{"code": failure.Code, "message": failure.Message}})
}

func JSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func SecurityHeaders(w http.ResponseWriter, spaceOrigin string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	connect := "'self'"
	if spaceOrigin != "" {
		connect += " " + spaceOrigin
	}
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src "+connect+"; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
}
