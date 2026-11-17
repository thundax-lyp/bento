package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
)

func TestOIDCAccountPurgeMySQL(t *testing.T) {
	host := os.Getenv("BENTO_MYSQL_HOST")
	if host == "" {
		t.Skip("set BENTO_MYSQL_HOST and the test MySQL account configuration")
	}
	cfg := mysql.NewConfig()
	cfg.Net, cfg.Addr = "tcp", host
	cfg.User, cfg.Passwd = os.Getenv("BENTO_MYSQL_USER"), os.Getenv("BENTO_MYSQL_PASSWORD")
	cfg.DBName = os.Getenv("BENTO_MYSQL_DATABASE")
	cfg.Timeout, cfg.ReadTimeout, cfg.WriteTimeout = 3*time.Second, 5*time.Second, 5*time.Second
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		t.Fatal(err)
	}
	openStore := func() accounts {
		db := sql.OpenDB(connector)
		db.SetMaxOpenConns(1)
		t.Cleanup(func() { _ = db.Close() })
		return accounts{db: db}
	}
	first, second := openStore(), openStore()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	if err := initializeAccounts(ctx, first.db, ""); err != nil {
		t.Fatal(err)
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		t.Fatal(err)
	}
	identity := oidcIdentity{
		Issuer:  "https://fixture.invalid/" + hex.EncodeToString(id[:]),
		Subject: "first",
		Account: "oidc-fixture@example.test",
	}
	otherIdentity := identity
	otherIdentity.Subject = "second"
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := second.db.ExecContext(ctx, "DELETE FROM web_accounts WHERE oidc_issuer = ? AND oidc_subject IN (?, ?)",
			identity.Issuer, identity.Subject, otherIdentity.Subject); err != nil {
			t.Errorf("clean up OIDC fixtures: %v", err)
		}
	})

	type linkResult struct {
		account account
		err     error
	}
	ready := make(chan struct{}, 2)
	start := make(chan struct{})
	results := make(chan linkResult, 2)
	for _, store := range []accounts{first, second} {
		go func() {
			ready <- struct{}{}
			<-start
			a, err := store.linkIdentity(ctx, identity)
			results <- linkResult{a, err}
		}()
	}
	<-ready
	<-ready
	close(start)
	a, b := <-results, <-results
	if a.err != nil || b.err != nil || a.account.Owner == "" || a.account.Owner != b.account.Owner || a.account.Closed || b.account.Closed {
		t.Fatalf("parallel OIDC binding did not return one open owner: %v, %v", a.err, b.err)
	}
	owner := a.account.Owner
	var count int
	err = first.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM web_accounts WHERE oidc_issuer = ? AND oidc_subject = ?",
		identity.Issuer, identity.Subject).Scan(&count)
	if err != nil || count != 1 {
		t.Fatalf("parallel OIDC binding produced %d rows: %v", count, err)
	}
	checkBinding := func(store accounts, claim oidcIdentity, closed bool) {
		t.Helper()
		bound, err := store.linkIdentity(ctx, claim)
		if err != nil || bound.Owner != owner || bound.Closed != closed || bound.Name != claim.Account {
			t.Fatalf("unexpected repeated OIDC binding: %v", err)
		}
	}
	checkBinding(second, identity, false)
	changedMail := identity
	changedMail.Account = "oidc-updated@example.test"
	checkBinding(second, changedMail, false)
	other, err := second.linkIdentity(ctx, otherIdentity)
	if err != nil || other.Owner == "" || other.Owner == owner || other.Closed {
		t.Fatalf("distinct subject did not receive an independent owner: %v", err)
	}

	changed, err := first.deactivate(ctx, owner, true)
	if err != nil || !changed {
		t.Fatalf("failed to close OIDC account: %v", err)
	}
	if err := first.db.Close(); err != nil {
		t.Fatal(err)
	}
	checkState := func(store accounts, pending bool) {
		t.Helper()
		closed, err := store.accountByOwner(ctx, owner)
		if err != nil || !closed.Closed {
			t.Fatalf("OIDC account closure did not persist: %v", err)
		}
		checkBinding(store, identity, true)
		purges, err := store.pendingPurges(ctx)
		if err != nil {
			t.Fatal(err)
		}
		index := slices.IndexFunc(purges, func(item purge) bool { return item.Owner == owner })
		if pending && (index < 0 || !purges[index].Space) || !pending && index >= 0 {
			t.Fatal("unexpected persisted cleanup request")
		}
		untouched, err := store.accountByOwner(ctx, other.Owner)
		if err != nil || untouched.Closed {
			t.Fatalf("account closure affected a second identity: %v", err)
		}
	}
	checkState(second, true)
	changed, err = second.deactivate(ctx, owner, false)
	if err != nil || changed {
		t.Fatalf("repeated closure changed account state: %v", err)
	}
	checkState(second, true)
	for range 2 {
		if err := second.finishPurge(ctx, owner); err != nil {
			t.Fatal(err)
		}
		checkState(second, false)
	}
	checkState(openStore(), false)
}
