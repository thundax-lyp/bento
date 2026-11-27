package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

func ReadJSON(w http.ResponseWriter, r *http.Request, maxBytes int64) (map[string]json.RawMessage, error) {
	media := strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0])
	if !strings.EqualFold(media, "application/json") {
		return nil, NewError(400, "invalid_content_type", "请使用 application/json。")
	}
	tooLarge := NewError(413, "too_large", "请求超过大小限制。")
	if r.ContentLength > maxBytes {
		return nil, tooLarge
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBytes))
	var limit *http.MaxBytesError
	if errors.As(err, &limit) {
		return nil, tooLarge
	}
	body = bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf})
	if err != nil || !utf8.Valid(body) || !json.Valid(body) {
		return nil, NewError(400, "invalid_json", "请求内容必须是 UTF-8 JSON。")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil || fields == nil {
		return nil, NewError(400, "invalid_input", "请求必须是 JSON 对象。")
	}
	return fields, nil
}

func String(raw json.RawMessage) (string, bool) {
	var value string
	valid := len(raw) != 0 && raw[0] == '"' && json.Unmarshal(raw, &value) == nil
	return value, valid
}

func WellFormedString(raw json.RawMessage) (string, bool) {
	value, ok := String(raw)
	if !ok {
		return "", false
	}
	// encoding/json replaces unpaired UTF-16 surrogates. The HTTP contract rejects them in paths and file text.
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if raw[i] != 'u' {
			continue
		}
		unit, _ := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		i += 4
		if unit < 0xd800 || unit > 0xdfff {
			continue
		}
		if unit >= 0xdc00 || i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
			return "", false
		}
		low, _ := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
		if low < 0xdc00 || low > 0xdfff {
			return "", false
		}
		i += 6
	}
	return value, true
}

func ResourceID(value string) bool {
	return value != "" && value != "." && value != ".." &&
		!strings.ContainsAny(value, "/\\") && !strings.ContainsFunc(value, unicode.IsControl)
}

func SecureURL(raw string, local bool) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return nil, errors.New("invalid Keycloak URL")
	}
	if u.Scheme == "https" || (local && u.Scheme == "http" && Loopback(u.Hostname())) {
		return u, nil
	}
	return nil, errors.New("Keycloak URLs require HTTPS")
}

func Loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func Integer(raw json.RawMessage, min int64) (int64, bool) {
	var number *float64
	if json.Unmarshal(raw, &number) != nil || number == nil || *number < float64(min) ||
		*number > 1<<53-1 || *number != float64(int64(*number)) {
		return 0, false
	}
	return int64(*number), true
}
