package space

import "sync"

type spaceLocks struct {
	mu     sync.Mutex
	active map[string]string
}

func (l *spaceLocks) acquire(id, token string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.active == nil {
		l.active = make(map[string]string)
	}
	if current, locked := l.active[id]; locked {
		return current == token
	}
	l.active[id] = token
	return true
}

func (l *spaceLocks) owns(id, token string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return token != "" && l.active[id] == token
}

func (l *spaceLocks) release(id, token string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.active[id] == token {
		delete(l.active, id)
	}
}
