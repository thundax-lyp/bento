package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"regexp"
)

type account struct {
	Name       string `json:"account"`
	Owner      string `json:"ownerId"`
	InviteHash string `json:"inviteSha256"`
	Salt       []byte `json:"salt,omitempty"`
	Hash       []byte `json:"scryptHash,omitempty"`
	Closed     bool   `json:"closed"`
}

func initializeAccounts(ctx context.Context, db *sql.DB, file string) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS web_accounts (
		owner_id VARBINARY(128) PRIMARY KEY,
		account VARBINARY(128) NOT NULL UNIQUE,
		invite_hash BINARY(64),
		salt BINARY(16),
		password_hash BINARY(32),
		closed BOOLEAN NOT NULL DEFAULT FALSE,
		purge_space BOOLEAN,
		oidc_issuer VARBINARY(512),
		oidc_subject VARBINARY(255),
		UNIQUE KEY oidc_identity (oidc_issuer, oidc_subject)
	) ENGINE=InnoDB`)
	if err != nil {
		return err
	}
	if file == "" {
		return nil
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	var invited []account
	if err := json.Unmarshal(data, &invited); err != nil || len(invited) == 0 {
		return errors.New("invalid invitations")
	}
	namePattern := regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,128}$`)
	ownerPattern := regexp.MustCompile(`^[A-Za-z0-9_.~-]{1,128}$`)
	hashPattern := regexp.MustCompile(`^[a-f0-9]{64}$`)
	names, owners := map[string]bool{}, map[string]bool{}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, a := range invited {
		if !namePattern.MatchString(a.Name) || !ownerPattern.MatchString(a.Owner) ||
			!hashPattern.MatchString(a.InviteHash) || names[a.Name] || owners[a.Owner] {
			return errors.New("invalid or duplicate invitation")
		}
		names[a.Name], owners[a.Owner] = true, true
		var name string
		err := tx.QueryRowContext(ctx, "SELECT account FROM web_accounts WHERE owner_id = ?", a.Owner).Scan(&name)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			_, err = tx.ExecContext(ctx, `INSERT INTO web_accounts
				(owner_id, account, invite_hash)
				VALUES (?, ?, ?)`, a.Owner, a.Name, a.InviteHash)
		case err == nil && name != a.Name:
			return errors.New("invitation owner does not match existing account")
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

type accounts struct{ db *sql.DB }

type purge struct {
	Owner string `json:"ownerId"`
	Space bool   `json:"spaceRequired"`
}

func (s accounts) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /internal/accounts/by-name/{name}", s.lookup)
	mux.HandleFunc("POST /internal/accounts/oidc", s.bindOIDC)
	mux.HandleFunc("GET /internal/accounts/by-owner/{owner}", s.lookup)
	mux.HandleFunc("POST /internal/accounts/{owner}/register", s.activate)
	mux.HandleFunc("POST /internal/accounts/{owner}/close", s.closeAccount)
	mux.HandleFunc("GET /internal/account-purges", s.pending)
	mux.HandleFunc("DELETE /internal/account-purges/{owner}", s.finish)
}

func (s accounts) lookup(w http.ResponseWriter, r *http.Request) {
	query := `SELECT account, owner_id, COALESCE(invite_hash, ''), salt, password_hash, closed
		FROM web_accounts WHERE `
	filter, value := "account", r.PathValue("name")
	if owner := r.PathValue("owner"); owner != "" {
		filter, value = "owner_id", owner
	}
	var a account
	err := s.db.QueryRowContext(r.Context(), query+filter+" = ?", value).Scan(
		&a.Name, &a.Owner, &a.InviteHash, &a.Salt, &a.Hash, &a.Closed)
	if errors.Is(err, sql.ErrNoRows) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	reply(w, a, err)
}

// Only the loopback task-entry can call this after verifying the OIDC claims.
func (s accounts) bindOIDC(w http.ResponseWriter, r *http.Request) {
	var input struct{ Issuer, Subject, Account string }
	if !decode(w, r, &input) {
		return
	}
	if len(input.Issuer) == 0 || len(input.Issuer) > 512 ||
		len(input.Subject) == 0 || len(input.Subject) > 255 ||
		len(input.Account) == 0 || len(input.Account) > 254 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	var id [24]byte
	if _, err := rand.Read(id[:]); err != nil {
		reply(w, nil, err)
		return
	}
	owner := hex.EncodeToString(id[:])
	_, err := s.db.ExecContext(r.Context(), `INSERT INTO web_accounts
		(owner_id, account, invite_hash, oidc_issuer, oidc_subject)
		VALUES (?, ?, NULL, ?, ?) ON DUPLICATE KEY UPDATE owner_id = owner_id`,
		owner, "oidc:"+owner, input.Issuer, input.Subject)
	if err != nil {
		reply(w, nil, err)
		return
	}
	result := account{Name: input.Account}
	err = s.db.QueryRowContext(r.Context(), `SELECT owner_id, closed FROM web_accounts
		WHERE oidc_issuer = ? AND oidc_subject = ?`, input.Issuer, input.Subject).Scan(&result.Owner, &result.Closed)
	reply(w, result, err)
}

func (s accounts) activate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Salt []byte
		Hash []byte
	}
	if !decode(w, r, &input) {
		return
	}
	if len(input.Salt) != 16 || len(input.Hash) != 32 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	result, err := s.db.ExecContext(r.Context(), `UPDATE web_accounts SET salt = ?, password_hash = ?
		WHERE owner_id = ? AND closed = FALSE AND password_hash IS NULL`, input.Salt, input.Hash, r.PathValue("owner"))
	changed(w, result, err)
}

func (s accounts) closeAccount(w http.ResponseWriter, r *http.Request) {
	var input struct{ SpaceRequired bool }
	if !decode(w, r, &input) {
		return
	}
	result, err := s.db.ExecContext(r.Context(), `UPDATE web_accounts SET closed = TRUE, salt = NULL,
		password_hash = NULL, purge_space = ? WHERE owner_id = ? AND closed = FALSE`, input.SpaceRequired, r.PathValue("owner"))
	changed(w, result, err)
}

func (s accounts) pending(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), "SELECT owner_id, purge_space FROM web_accounts WHERE purge_space IS NOT NULL")
	if err != nil {
		reply(w, nil, err)
		return
	}
	defer rows.Close()
	result := []purge{}
	for rows.Next() {
		var p purge
		if err := rows.Scan(&p.Owner, &p.Space); err != nil {
			reply(w, nil, err)
			return
		}
		result = append(result, p)
	}
	reply(w, result, rows.Err())
}

func (s accounts) finish(w http.ResponseWriter, r *http.Request) {
	_, err := s.db.ExecContext(r.Context(), "UPDATE web_accounts SET purge_space = NULL WHERE owner_id = ?", r.PathValue("owner"))
	reply(w, nil, err)
}

func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(value); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return false
	}
	return true
}

func changed(w http.ResponseWriter, result sql.Result, err error) {
	if err != nil {
		reply(w, nil, err)
		return
	}
	count, err := result.RowsAffected()
	reply(w, count == 1, err)
}

func reply(w http.ResponseWriter, value any, err error) {
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
