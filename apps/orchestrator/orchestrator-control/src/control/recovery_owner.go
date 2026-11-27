package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type recoveryOwnerRequest struct {
	Method     string `json:"method"`
	Deployment string `json:"deployment"`
	Source     string `json:"source"`
	Target     string `json:"target"`
	Epoch      int64  `json:"epoch"`
	Checkpoint string `json:"checkpoint"`
	Isolation  string `json:"isolation"`
}

type recoveryOwner struct {
	Host       string `json:"host"`
	Epoch      int64  `json:"epoch"`
	Checkpoint string `json:"checkpoint"`
	Isolation  string `json:"isolation"`
}

func recoveryDigest(value string) bool {
	bytes, err := hex.DecodeString(value)
	return err == nil && len(bytes) == 32 && value == strings.ToLower(value)
}

// The management plane owns this database. It is independent of execution backups.
func runRecoveryOwner(ctx context.Context, path string, in io.Reader, out io.Writer) error {
	decoder := json.NewDecoder(io.LimitReader(in, 4096))
	decoder.DisallowUnknownFields()
	var request recoveryOwnerRequest
	if err := decoder.Decode(&request); err != nil {
		return err
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("expected one recovery owner request")
	}
	result, err := changeRecoveryOwner(ctx, path, request)
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(result)
}

func changeRecoveryOwner(ctx context.Context, path string, request recoveryOwnerRequest) (recoveryOwner, error) {
	var owner recoveryOwner
	if path == "" || strings.TrimSpace(request.Deployment) == "" {
		return owner, errors.New("recovery owner database and deployment are required")
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return owner, err
	}
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		if err = file.Close(); err != nil {
			return owner, err
		}
	} else if !errors.Is(err, os.ErrExist) {
		return owner, err
	}
	address := url.URL{Scheme: "file", Path: path,
		RawQuery: "mode=rw&_pragma=busy_timeout(5000)&_pragma=synchronous(FULL)&_txlock=immediate"}
	db, err := sql.Open("sqlite", address.String())
	if err != nil {
		return owner, err
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return owner, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS recovery_owners (
			deployment TEXT NOT NULL,
			epoch INTEGER NOT NULL CHECK (epoch > 0),
			host TEXT NOT NULL,
			checkpoint TEXT NOT NULL,
			isolation TEXT NOT NULL,
			PRIMARY KEY (deployment, epoch)
		)`); err != nil {
		return owner, err
	}
	switch request.Method {
	case "initialize":
		if strings.TrimSpace(request.Target) == "" {
			return owner, errors.New("initial host is required")
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO recovery_owners VALUES (?, 1, ?, '', '')
			ON CONFLICT DO NOTHING`, request.Deployment, request.Target); err != nil {
			return owner, err
		}
	case "transfer":
		if request.Epoch < 1 || strings.TrimSpace(request.Source) == "" ||
			strings.TrimSpace(request.Target) == "" || request.Source == request.Target ||
			!recoveryDigest(request.Checkpoint) || !recoveryDigest(request.Isolation) {
			return owner, errors.New("transfer requires source, target, epoch and evidence digests")
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO recovery_owners
			SELECT deployment, epoch + 1, ?, ?, ?
			FROM recovery_owners
			WHERE deployment = ? AND host = ? AND epoch = ?
				AND epoch = (SELECT MAX(epoch) FROM recovery_owners WHERE deployment = ?)`,
			request.Target, request.Checkpoint, request.Isolation,
			request.Deployment, request.Source, request.Epoch, request.Deployment); err != nil {
			return owner, err
		}
	case "inspect":
	default:
		return owner, errors.New("unknown recovery owner request")
	}
	if err := tx.QueryRowContext(ctx, `
		SELECT host, epoch, checkpoint, isolation FROM recovery_owners
		WHERE deployment = ? ORDER BY epoch DESC LIMIT 1`, request.Deployment).
		Scan(&owner.Host, &owner.Epoch, &owner.Checkpoint, &owner.Isolation); err != nil {
		return owner, err
	}
	switch request.Method {
	case "initialize":
		if owner.Epoch != 1 || owner.Host != request.Target {
			return recoveryOwner{}, errors.New("recovery owner changed")
		}
	case "transfer":
		var previousHost string
		if err := tx.QueryRowContext(ctx, `
			SELECT host FROM recovery_owners WHERE deployment = ? AND epoch = ?`,
			request.Deployment, request.Epoch).Scan(&previousHost); err != nil {
			return recoveryOwner{}, err
		}
		if previousHost != request.Source || owner.Epoch != request.Epoch+1 || owner.Host != request.Target ||
			owner.Checkpoint != request.Checkpoint || owner.Isolation != request.Isolation {
			return recoveryOwner{}, errors.New("recovery owner changed")
		}
	}
	if err := tx.Commit(); err != nil {
		return recoveryOwner{}, err
	}
	return owner, nil
}
