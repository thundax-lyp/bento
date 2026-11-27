package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

// During the cutover, the legacy router owns per-upload serialization across
// uploads, deletion, and background cleanup. It holds that lock through this call.
func registerSpaceUploadBridge(mux *http.ServeMux, db *sql.DB, storage *spaceStorage, backend projectService) {
	service := spaceUploads{db: db, storage: storage, now: time.Now}
	mux.HandleFunc("POST /internal/space/upload/{action}", func(w http.ResponseWriter, r *http.Request) {
		if err := service.uploadBridge(w, r, spaceFileDeletion{db: db, storage: storage, hold: backend.fileHold},
			spaceSnapshots{db: db, read: storage.read}); err != nil {
			var failure *snapshotFailure
			if errors.As(err, &failure) {
				body := map[string]any{"code": failure.code, "message": failure.message}
				if len(failure.Issues) != 0 {
					body["issues"] = failure.Issues
				}
				authJSON(w, failure.status, map[string]any{"error": body})
				return
			}
			authFailure(w, err)
		}
	})
}

func (s spaceUploads) uploadBridge(w http.ResponseWriter, r *http.Request, deletion spaceFileDeletion, snapshots spaceSnapshots) error {
	fields, err := readProjectJSON(w, r, 64*1024)
	if err != nil {
		return err
	}
	owner, valid := projectString(fields["owner"])
	if !valid || owner == "" {
		return notFound
	}
	ctx := r.Context()
	action := r.PathValue("action")
	if action == "reserve" {
		project, _ := projectString(fields["project"])
		if !taskUUID.MatchString(project) {
			return notFound
		}
		var input map[string]json.RawMessage
		if json.Unmarshal(fields["input"], &input) != nil || input == nil {
			return &requestFailure{400, "invalid_input", "请求必须是 JSON 对象。"}
		}
		reservation, err := parseUploadReservation(input)
		if err != nil {
			return err
		}
		row, err := s.reserve(ctx, owner, project, reservation)
		if err != nil {
			return err
		}
		authJSON(w, 200, map[string]string{"id": row.ID})
		return nil
	}
	if action == "purge-metadata" {
		complete, err := s.purgeAccountMetadata(ctx, owner)
		if err != nil {
			return err
		}
		authJSON(w, http.StatusOK, map[string]bool{"complete": complete})
		return nil
	}
	id, _ := projectString(fields["id"])
	if !taskUUID.MatchString(id) {
		return notFound
	}
	if action == "freeze-snapshot" {
		if err := snapshots.freeze(ctx, owner, id); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	row, err := loadSpaceUpload(ctx, s.db, id)
	if errors.Is(err, sql.ErrNoRows) {
		return notFound
	}
	if err != nil {
		return err
	}
	if row.owner != owner {
		return notFound
	}
	switch action {
	case "purge-file":
		complete, err := s.purgeAccountObject(ctx, row)
		if err != nil {
			return err
		}
		authJSON(w, http.StatusOK, map[string]bool{"complete": complete})
		return nil
	case "delete":
		status, err := deletion.request(ctx, owner, id)
		if err != nil {
			return err
		}
		authJSON(w, http.StatusOK, map[string]int{"deleteStatus": status})
		return nil
	case "advance-delete":
		err = deletion.advance(ctx, row)
	case "prepare":
		err = s.prepare(ctx, &row)
	case "finish":
		err = s.finish(ctx, &row)
	case "clean":
		outcome, _ := projectString(fields["outcome"])
		switch outcome {
		case "cancelled", "expired", "failed":
			err = s.clean(ctx, &row, outcome)
		default:
			return notFound
		}
	case "parts":
		parts, exists, err := s.completedParts(ctx, row)
		if err != nil {
			return err
		}
		if !exists {
			parts = nil
		}
		authJSON(w, 200, parts)
		return nil
	case "sign":
		number, err := taskInteger(1)(fields["number"])
		if err != nil || number.(int64) > 100 {
			return invalidSpace("分块编号无效。")
		}
		signed, checksum, err := s.signPart(ctx, &row, int32(number.(int64)))
		if err != nil {
			return err
		}
		authJSON(w, 200, map[string]string{"url": signed, "checksum": checksum})
		return nil
	default:
		return notFound
	}
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
