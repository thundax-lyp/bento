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

func (s accounts) accountByName(ctx context.Context, name string) (account, error) {
	return scanAccount(s.db.QueryRowContext(ctx, accountSelect+"account = ?", name))
}

func (s accounts) accountByOwner(ctx context.Context, owner string) (account, error) {
	return scanAccount(s.db.QueryRowContext(ctx, accountSelect+"owner_id = ?", owner))
}

const accountSelect = `SELECT account, owner_id, COALESCE(invite_hash, ''), salt, password_hash, closed
	FROM web_accounts WHERE `

func scanAccount(row *sql.Row) (account, error) {
	var a account
	err := row.Scan(&a.Name, &a.Owner, &a.InviteHash, &a.Salt, &a.Hash, &a.Closed)
	return a, err
}

func (s accounts) lookup(w http.ResponseWriter, r *http.Request) {
	var a account
	var err error
	if owner := r.PathValue("owner"); owner != "" {
		a, err = s.accountByOwner(r.Context(), owner)
	} else {
		a, err = s.accountByName(r.Context(), r.PathValue("name"))
	}
	if errors.Is(err, sql.ErrNoRows) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	reply(w, a, err)
}

type oidcIdentity struct{ Issuer, Subject, Account string }

func (i oidcIdentity) valid() bool {
	return len(i.Issuer) > 0 && len(i.Issuer) <= 512 &&
		len(i.Subject) > 0 && len(i.Subject) <= 255 &&
		len(i.Account) > 0 && len(i.Account) <= 254
}

// linkIdentity accepts claims verified by the caller and returns the persisted binding.
func (s accounts) linkIdentity(ctx context.Context, identity oidcIdentity) (account, error) {
	var id [24]byte
	if _, err := rand.Read(id[:]); err != nil {
		return account{}, err
	}
	owner := hex.EncodeToString(id[:])
	_, err := s.db.ExecContext(ctx, `INSERT INTO web_accounts
		(owner_id, account, invite_hash, oidc_issuer, oidc_subject)
		VALUES (?, ?, NULL, ?, ?) ON DUPLICATE KEY UPDATE owner_id = owner_id`,
		owner, "oidc:"+owner, identity.Issuer, identity.Subject)
	if err != nil {
		return account{}, err
	}
	result := account{Name: identity.Account}
	err = s.db.QueryRowContext(ctx, `SELECT owner_id, closed FROM web_accounts
		WHERE oidc_issuer = ? AND oidc_subject = ?`, identity.Issuer, identity.Subject).Scan(&result.Owner, &result.Closed)
	return result, err
}

func (s accounts) bindOIDC(w http.ResponseWriter, r *http.Request) {
	var input oidcIdentity
	if !decode(w, r, &input) {
		return
	}
	if !input.valid() {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	a, err := s.linkIdentity(r.Context(), input)
	reply(w, a, err)
}

func (s accounts) registerPassword(ctx context.Context, owner string, salt, hash []byte) (bool, error) {
	return changed(s.db.ExecContext(ctx, `UPDATE web_accounts SET salt = ?, password_hash = ?
		WHERE owner_id = ? AND closed = FALSE AND password_hash IS NULL`, salt, hash, owner))
}

func (s accounts) activate(w http.ResponseWriter, r *http.Request) {
	var input struct{ Salt, Hash []byte }
	if !decode(w, r, &input) {
		return
	}
	if len(input.Salt) != 16 || len(input.Hash) != 32 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	ok, err := s.registerPassword(r.Context(), r.PathValue("owner"), input.Salt, input.Hash)
	reply(w, ok, err)
}

func (s accounts) deactivate(ctx context.Context, owner string, spaceRequired bool) (bool, error) {
	return changed(s.db.ExecContext(ctx, `UPDATE web_accounts SET closed = TRUE, salt = NULL,
		password_hash = NULL, purge_space = ? WHERE owner_id = ? AND closed = FALSE`, spaceRequired, owner))
}

func (s accounts) closeAccount(w http.ResponseWriter, r *http.Request) {
	var input struct{ SpaceRequired bool }
	if !decode(w, r, &input) {
		return
	}
	ok, err := s.deactivate(r.Context(), r.PathValue("owner"), input.SpaceRequired)
	reply(w, ok, err)
}

func (s accounts) pendingPurges(ctx context.Context) ([]purge, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT owner_id, purge_space FROM web_accounts WHERE purge_space IS NOT NULL")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []purge{}
	for rows.Next() {
		var p purge
		if err := rows.Scan(&p.Owner, &p.Space); err != nil {
			return nil, err
		}
		result = append(result, p)
	}
	return result, rows.Err()
}

func (s accounts) pending(w http.ResponseWriter, r *http.Request) {
	purges, err := s.pendingPurges(r.Context())
	reply(w, purges, err)
}

func (s accounts) finishPurge(ctx context.Context, owner string) error {
	_, err := s.db.ExecContext(ctx, "UPDATE web_accounts SET purge_space = NULL WHERE owner_id = ?", owner)
	return err
}

func (s accounts) finish(w http.ResponseWriter, r *http.Request) {
	reply(w, nil, s.finishPurge(r.Context(), r.PathValue("owner")))
}

func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(value); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return false
	}
	return true
}

func changed(result sql.Result, err error) (bool, error) {
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count == 1, err
}

func reply(w http.ResponseWriter, value any, err error) {
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
