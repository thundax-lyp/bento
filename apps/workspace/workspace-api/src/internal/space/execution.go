package space

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/auth"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/httpx"
	"github.com/thundax-lyp/bento/apps/workspace/workspace-api/src/internal/orchestrator"
)

type executionInput struct {
	ID       string `json:"fileId"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Manifest string `json:"manifest"`
}

type executionIntent struct {
	space, owner, key, state  string
	inputs                    []executionInput
	project, snapshot, issues sql.NullString
}

const executionColumns = "spaceId,owner,key,state,inputs,projectId,snapshot,issues"

func loadExecution(row *sql.Row) (executionIntent, error) {
	var intent executionIntent
	var inputs string
	err := row.Scan(&intent.space, &intent.owner, &intent.key, &intent.state, &inputs, &intent.project, &intent.snapshot, &intent.issues)
	if err == nil {
		err = json.Unmarshal([]byte(inputs), &intent.inputs)
	}
	return intent, err
}

type spaceExecution struct {
	db      *sql.DB
	storage *spaceStorage
	backend orchestrator.Client
	wake    chan struct{}
	locks   *spaceLocks
}

func (s spaceExecution) register(ctx context.Context, owner, id, name string) error {
	return spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
		var draining, deleted bool
		if err := conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM space_draining_owners WHERE owner=?),
     EXISTS(SELECT 1 FROM space_project_deletions WHERE spaceId=? AND phase='deleted')`, owner, id).Scan(&draining, &deleted); err != nil {
			return err
		}
		if draining {
			return projectDeletionBlocked("project_busy")
		}
		if deleted {
			return httpx.NotFound
		}
		if _, err := conn.ExecContext(ctx, "INSERT OR IGNORE INTO space_projects VALUES (?,?,?)", id, owner, name); err != nil {
			return err
		}
		var saved string
		err := conn.QueryRowContext(ctx, "SELECT name FROM space_projects WHERE id=? AND owner=?", id, owner).Scan(&saved)
		if errors.Is(err, sql.ErrNoRows) {
			return httpx.NotFound
		}
		if err != nil {
			return err
		}
		if saved != name {
			return spaceConflict("同一项目编号对应不同名称。")
		}
		return nil
	})
}

type executionQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func executionView(ctx context.Context, db executionQuery, intent executionIntent) (map[string]any, error) {
	type file struct {
		ID        string `json:"fileId"`
		Path      string `json:"path"`
		Size      int64  `json:"size"`
		Available bool   `json:"available"`
	}
	inputs := make([]file, 0, len(intent.inputs))
	for _, input := range intent.inputs {
		item := file{ID: input.ID, Path: input.Path, Size: input.Size}
		err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM space_uploads WHERE owner=? AND project=? AND id=? AND state='saved')`, intent.owner, intent.space, input.ID).Scan(&item.Available)
		if err != nil {
			return nil, err
		}
		inputs = append(inputs, item)
	}
	result := map[string]any{"state": intent.state, "inputs": inputs}
	if intent.project.Valid {
		result["projectId"] = intent.project.String
	}
	if intent.issues.Valid {
		result["issues"] = json.RawMessage(intent.issues.String)
	}
	return result, nil
}

func (s spaceExecution) detail(ctx context.Context, owner, id string) (map[string]any, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var name string
	var deleting bool
	err = tx.QueryRowContext(ctx, `SELECT name,EXISTS(SELECT 1 FROM space_project_deletions WHERE spaceId=? AND owner=?)
    FROM space_projects WHERE id=? AND owner=?`, id, owner, id, owner).Scan(&name, &deleting)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.NotFound
	}
	if err != nil {
		return nil, err
	}
	type file struct {
		ID   string `json:"id"`
		Path string `json:"path"`
		Size int64  `json:"size"`
	}
	files := []file{}
	result := map[string]any{"id": id, "name": name, "execution": map[string]string{"state": "uninitialized"}, "files": files}
	if deleting {
		result["state"] = "deleting"
		return result, nil
	}
	intent, err := loadExecution(tx.QueryRowContext(ctx, "SELECT "+executionColumns+" FROM space_execution WHERE spaceId=? AND owner=? ORDER BY rowid DESC LIMIT 1", id, owner))
	if !errors.Is(err, sql.ErrNoRows) {
		if err != nil {
			return nil, err
		}
		view, err := executionView(ctx, tx, intent)
		if err != nil {
			return nil, err
		}
		result["execution"] = view
	}
	rows, err := tx.QueryContext(ctx, "SELECT id,path,size FROM space_uploads WHERE owner=? AND project=? AND state='saved' ORDER BY id", owner, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item file
		if err := rows.Scan(&item.ID, &item.Path, &item.Size); err != nil {
			return nil, err
		}
		files = append(files, item)
	}
	result["files"] = files
	return result, rows.Err()
}

func (s spaceExecution) enroll(ctx context.Context, owner, id, key string, ids []string) (int, map[string]any, error) {
	status := http.StatusAccepted
	var result map[string]any
	err := spaceImmediate(ctx, s.db, func(conn *sql.Conn) error {
		var found, blocked bool
		err := conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM space_projects WHERE id=? AND owner=?),
    EXISTS(SELECT 1 FROM space_project_deletions WHERE spaceId=? AND owner=?) OR
    EXISTS(SELECT 1 FROM space_draining_owners WHERE owner=?)`, id, owner, id, owner, owner).Scan(&found, &blocked)
		if err != nil {
			return err
		}
		if !found {
			return httpx.NotFound
		}
		if blocked {
			return projectDeletionBlocked("project_busy")
		}
		intent, err := loadExecution(conn.QueryRowContext(ctx, "SELECT "+executionColumns+" FROM space_execution WHERE spaceId=? AND key=?", id, key))
		if err == nil {
			previous := make([]string, 0, len(intent.inputs))
			for _, input := range intent.inputs {
				previous = append(previous, input.ID)
			}
			if !slices.Equal(ids, previous) {
				return httpx.NewError(409, "idempotency_conflict", "此提交键已用于其他文件。")
			}
			status = http.StatusOK
			result, err = executionView(ctx, conn, intent)
			return err
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err := conn.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM space_execution WHERE spaceId=? AND (state<>'failed' OR projectId IS NOT NULL))", id).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return httpx.NewError(409, "execution_already_bound", "项目已有工作区或正在初始化，请查看原记录。")
		}
		intent = executionIntent{space: id, owner: owner, key: key, state: "validating"}
		var total int64
		issues := make([]snapshotIssue, 0, len(ids))
		for _, file := range ids {
			item := executionInput{ID: file}
			err := conn.QueryRowContext(ctx, `SELECT path,size,manifest FROM space_uploads u WHERE owner=? AND project=? AND id=? AND state='saved'
      AND NOT EXISTS(SELECT 1 FROM space_file_deletions WHERE fileId=u.id)`, owner, id, file).Scan(&item.Path, &item.Size, &item.Manifest)
			if errors.Is(err, sql.ErrNoRows) {
				return httpx.NotFound
			}
			if err != nil {
				return err
			}
			total += item.Size
			issues = append(issues, snapshotIssue{file, item.Path, "execution_input_too_large"})
			intent.inputs = append(intent.inputs, item)
		}
		if total > 1024*1024 {
			return &snapshotFailure{httpx.NewError(413, "execution_input_too_large", "执行输入合计最多 1 MiB。"), issues}
		}
		raw, err := json.Marshal(intent.inputs)
		if err != nil {
			return err
		}
		if _, err := conn.ExecContext(ctx, "INSERT INTO space_execution (spaceId,owner,key,state,inputs) VALUES (?,?,?,?,?)", id, owner, key, intent.state, string(raw)); err != nil {
			return err
		}
		result, err = executionView(ctx, conn, intent)
		return err
	})
	return status, result, err
}

func (s spaceExecution) validate(ctx context.Context, row executionIntent) error {
	files := make([]orchestrator.ProjectFile, 0, len(row.inputs))
	var issues []snapshotIssue
	for _, input := range row.inputs {
		if !validSnapshotPath(input.Path) {
			issues = append(issues, snapshotIssue{input.ID, input.Path, "invalid_path"})
			continue
		}
		data, err := s.storage.read(ctx, spaceObjectKey(input.ID), input.Size)
		if err != nil {
			return err
		}
		if input.Size != 0 {
			var manifest []string
			hash := sha256.Sum256(data)
			if json.Unmarshal([]byte(input.Manifest), &manifest) != nil || len(manifest) == 0 || base64.StdEncoding.EncodeToString(hash[:]) != manifest[0] {
				return httpx.BackendUnavailable
			}
		}
		if !utf8.Valid(data) {
			issues = append(issues, snapshotIssue{input.ID, input.Path, "invalid_utf8"})
			continue
		}
		files = append(files, orchestrator.ProjectFile{Path: input.Path, Text: string(data)})
	}
	if len(issues) != 0 {
		raw, err := json.Marshal(issues)
		if err != nil {
			return err
		}
		_, err = s.db.ExecContext(ctx, "UPDATE space_execution SET state='failed',issues=? WHERE spaceId=? AND key=? AND state='validating'", string(raw), row.space, row.key)
		return err
	}
	input := orchestrator.ProjectInput{Files: files}
	if err := s.db.QueryRowContext(ctx, "SELECT name FROM space_projects WHERE id=? AND owner=?", row.space, row.owner).Scan(&input.Name); err != nil {
		return err
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, "UPDATE space_execution SET state='importing',snapshot=? WHERE spaceId=? AND key=? AND state='validating'", string(raw), row.space, row.key)
	return err
}

func (s spaceExecution) advance(ctx context.Context, space, key string) error {
	get := func() (executionIntent, error) {
		return loadExecution(s.db.QueryRowContext(ctx, "SELECT "+executionColumns+` FROM space_execution e WHERE spaceId=? AND key=?
  AND NOT EXISTS(SELECT 1 FROM space_draining_owners d WHERE d.owner=e.owner)`, space, key))
	}
	row, err := get()
	if err != nil {
		return err
	}
	lock, token := "execution:"+row.owner, uuid.NewString()
	if !s.locks.acquire(lock, token) {
		return nil
	}
	defer s.locks.release(lock, token)
	row, err = get()
	if err != nil {
		return err
	}
	if row.state == "validating" {
		if err := s.validate(ctx, row); err != nil {
			return err
		}
		row, err = get()
		if err != nil {
			return err
		}
	}
	if row.state != "importing" {
		return nil
	}
	route := orchestrator.ProjectRoute{Kind: "project", Project: row.project.String}
	var input any
	var submissionKey string
	if !row.project.Valid {
		// The digest uses the same JSON string encoding as the initial submission.
		var buffer bytes.Buffer
		buffer.WriteByte('[')
		appendSnapshotString(&buffer, space)
		buffer.WriteByte(',')
		appendSnapshotString(&buffer, key)
		buffer.WriteByte(']')
		submissionKey = fmt.Sprintf("space-init-%x", sha256.Sum256(buffer.Bytes()))
		route.Kind = "createProject"
		input = json.RawMessage(row.snapshot.String)
	}
	_, value, err := s.backend.Invoke(ctx, row.owner, submissionKey, route, input)
	if err != nil {
		return err
	}
	project, ok := value.(orchestrator.ProjectView)
	if !ok {
		return httpx.BackendUnavailable
	}
	_, err = s.db.ExecContext(ctx, "UPDATE space_execution SET projectId=?,state=?,snapshot=NULL WHERE spaceId=? AND key=? AND state='importing'", project.ID, project.Status, space, key)
	return err
}

func (s spaceExecution) start(ctx context.Context) func() {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		timer := time.NewTicker(2 * time.Second)
		defer timer.Stop()
		for ctx.Err() == nil {
			s.reconcile(ctx)
			select {
			case <-ctx.Done():
				return
			case <-s.wake:
			case <-timer.C:
			}
		}
	}()
	return func() { cancel(); <-done }
}

func (s spaceExecution) reconcile(ctx context.Context) {
	rows, err := s.db.QueryContext(ctx, "SELECT spaceId,key FROM space_execution WHERE state IN ('validating','importing')")
	if err != nil {
		return
	}
	var pending [][2]string
	for rows.Next() {
		var item [2]string
		if err := rows.Scan(&item[0], &item[1]); err != nil {
			rows.Close()
			return
		}
		pending = append(pending, item)
	}
	rows.Close()
	if rows.Err() != nil {
		return
	}
	for _, item := range pending {
		if ctx.Err() != nil {
			return
		}
		_ = s.advance(ctx, item[0], item[1])
	}
}

func (s spaceExecution) routes(mux *http.ServeMux, current func(*http.Request) (*auth.Session, error), headers func(http.ResponseWriter), origin string) {
	register := func(pattern string, handle func(http.ResponseWriter, *http.Request, string) error) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			headers(w)
			if r.Method == http.MethodPost && (len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != origin) {
				httpx.Fail(w, httpx.NewError(400, "invalid_origin", "请从任务入口提交请求。"))
				return
			}
			session, err := current(r)
			if err == nil {
				if r.Method == http.MethodHead || r.PathValue("project") != "" && !orchestrator.ValidTaskID(r.PathValue("project")) {
					err = httpx.NotFound
				} else {
					err = handle(w, r, session.Owner)
				}
			}
			if err != nil {
				httpx.Fail(w, err)
			}
		})
	}
	register("POST /api/space/projects", func(w http.ResponseWriter, r *http.Request, owner string) error {
		data, err := httpx.ReadJSON(w, r, 32*1024)
		if err != nil {
			return err
		}
		id, _ := httpx.String(data["id"])
		if !orchestrator.ValidTaskID(id) {
			return httpx.NotFound
		}
		name, _ := httpx.String(data["name"])
		name = strings.TrimSpace(name)
		if name == "" || len(utf16.Encode([]rune(name))) > 120 || strings.ContainsFunc(name, unicode.IsControl) {
			return invalidSpace("项目名称无效。")
		}
		if err := s.register(r.Context(), owner, id, name); err != nil {
			return err
		}
		httpx.JSON(w, http.StatusOK, map[string]string{"id": id})
		return nil
	})
	register("GET /api/space/projects/{project}", func(w http.ResponseWriter, r *http.Request, owner string) error {
		result, err := s.detail(r.Context(), owner, r.PathValue("project"))
		if err == nil {
			httpx.JSON(w, http.StatusOK, result)
		}
		return err
	})
	register("POST /api/space/projects/{project}/execution", func(w http.ResponseWriter, r *http.Request, owner string) error {
		keys := r.Header.Values("Idempotency-Key")
		if len(keys) != 1 || len(keys[0]) < 1 || len(keys[0]) > 128 || strings.ContainsFunc(keys[0], func(r rune) bool { return r < 33 || r > 126 }) {
			return httpx.NewError(400, "invalid_key", "请提供有效的 Idempotency-Key。")
		}
		data, err := httpx.ReadJSON(w, r, 32*1024)
		if err != nil {
			return err
		}
		invalid := httpx.NewError(400, "invalid_execution_input", "请选择不重复的项目文件。")
		var fileIDs []json.RawMessage
		if json.Unmarshal(data["fileIds"], &fileIDs) != nil || len(fileIDs) == 0 {
			return invalid
		}
		ids := make([]string, 0, len(fileIDs))
		seen := make(map[string]bool, len(fileIDs))
		for _, raw := range fileIDs {
			id, ok := httpx.String(raw)
			if !ok || seen[id] {
				return invalid
			}
			seen[id] = true
			ids = append(ids, id)
		}
		if len(ids) > 100 {
			return httpx.NewError(413, "execution_input_too_large", "执行输入最多 100 个文件。")
		}
		slices.Sort(ids)
		status, result, err := s.enroll(r.Context(), owner, r.PathValue("project"), keys[0], ids)
		if err == nil {
			httpx.JSON(w, status, result)
			if status == http.StatusAccepted {
				select {
				case s.wake <- struct{}{}:
				default:
				}
			}
		}
		return err
	})
}
