package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lib/pq"
)

type taskReader interface {
	List(context.Context) ([]Task, error)
	Get(context.Context, int) (Task, error)
	Create(context.Context, CreateTaskInput) (Task, error)
	Update(context.Context, int, UpdateTaskInput) (Task, error)
	Delete(context.Context, int) (bool, error)
}

type sqlTaskReader struct{ db *sql.DB }

const (
	taskColumns      = `id,title,description,status,priority,assigned_to,created_by,created_at,updated_at`
	maxTaskBodyBytes = 64 * 1024
	maxTitleRunes    = 200
	maxDescRunes     = 2000
)

var positiveDecimalID = regexp.MustCompile(`^[0-9]+$`)

func (s sqlTaskReader) List(ctx context.Context) ([]Task, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+taskColumns+` FROM tasks ORDER BY created_at ASC,id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Task, 0)
	for rows.Next() {
		var t Task
		if err = rows.Scan(&t.ID, &t.Title, &t.Description, &t.Status, &t.Priority, &t.AssignedTo, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		t.CreatedAt, t.UpdatedAt = t.CreatedAt.UTC(), t.UpdatedAt.UTC()
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s sqlTaskReader) Get(ctx context.Context, id int) (Task, error) {
	var t Task
	err := s.db.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM tasks WHERE id=$1`, id).Scan(&t.ID, &t.Title, &t.Description, &t.Status, &t.Priority, &t.AssignedTo, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt)
	t.CreatedAt, t.UpdatedAt = t.CreatedAt.UTC(), t.UpdatedAt.UTC()
	return t, err
}

func (s sqlTaskReader) Create(ctx context.Context, input CreateTaskInput) (Task, error) {
	var t Task
	err := s.db.QueryRowContext(
		ctx,
		`INSERT INTO tasks (title, description, status, priority, assigned_to, created_by) VALUES ($1, $2, 'todo', $3, $4, $5) RETURNING `+taskColumns,
		input.Title,
		input.Description,
		input.Priority,
		input.AssignedTo,
		input.CreatedBy,
	).Scan(&t.ID, &t.Title, &t.Description, &t.Status, &t.Priority, &t.AssignedTo, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt)
	t.CreatedAt, t.UpdatedAt = t.CreatedAt.UTC(), t.UpdatedAt.UTC()
	return t, err
}

func (s sqlTaskReader) Update(ctx context.Context, id int, input UpdateTaskInput) (Task, error) {
	var t Task
	err := s.db.QueryRowContext(
		ctx,
		`UPDATE tasks SET title=$1, description=$2, priority=$3, assigned_to=$4, status=$5, updated_at=CURRENT_TIMESTAMP WHERE id=$6 RETURNING `+taskColumns,
		input.Title,
		input.Description,
		input.Priority,
		input.AssignedTo,
		input.Status,
		id,
	).Scan(&t.ID, &t.Title, &t.Description, &t.Status, &t.Priority, &t.AssignedTo, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt)
	t.CreatedAt, t.UpdatedAt = t.CreatedAt.UTC(), t.UpdatedAt.UTC()
	return t, err
}

func (s sqlTaskReader) Delete(ctx context.Context, id int) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM tasks WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return rows > 0, nil
}

func parseTaskPathID(rawID string) (int, bool) {
	id, err := strconv.Atoi(rawID)
	if !positiveDecimalID.MatchString(rawID) || err != nil || id <= 0 || int64(id) > 2147483647 {
		return 0, false
	}
	return id, true
}

func taskHandlers(reader taskReader) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/tasks", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		tasks, err := reader.List(ctx)
		if err != nil {
			log.Printf("query tasks: %v", err)
			writeError(w, http.StatusInternalServerError, "internal_error", "unable to retrieve tasks", nil)
			return
		}
		if tasks == nil {
			tasks = []Task{}
		}
		writeJSON(w, tasks)
	})
	mux.HandleFunc("POST /api/tasks", func(w http.ResponseWriter, r *http.Request) {
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || !strings.EqualFold(mediaType, "application/json") {
			writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json.", nil)
			return
		}

		input, status, code, msg, fields := decodeAndValidateCreateTask(w, r.Body)
		if status != 0 {
			writeError(w, status, code, msg, fields)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		task, err := reader.Create(ctx, input)
		if err != nil {
			if constraintFields, ok := mapCreateTaskError(err); ok {
				writeError(w, http.StatusBadRequest, "validation_failed", "Check the task fields.", constraintFields)
				return
			}
			log.Printf("create task: %v", err)
			writeError(w, http.StatusInternalServerError, "internal_error", "unable to create task", nil)
			return
		}

		w.Header().Set("Location", "/api/tasks/"+strconv.Itoa(task.ID))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(task)
	})
	mux.HandleFunc("GET /api/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := parseTaskPathID(r.PathValue("id"))
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid_task_id", "invalid task id", nil)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		task, err := reader.Get(ctx, id)
		if err == sql.ErrNoRows {
			writeError(w, http.StatusNotFound, "not_found", "task not found", nil)
			return
		}
		if err != nil {
			log.Printf("query task: %v", err)
			writeError(w, http.StatusInternalServerError, "internal_error", "unable to retrieve task", nil)
			return
		}
		writeJSON(w, task)
	})
	mux.HandleFunc("PUT /api/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := parseTaskPathID(r.PathValue("id"))
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid_task_id", "invalid task id", nil)
			return
		}

		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || !strings.EqualFold(mediaType, "application/json") {
			writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json.", nil)
			return
		}

		input, status, code, msg, fields := decodeAndValidateUpdateTask(w, r.Body)
		if status != 0 {
			writeError(w, status, code, msg, fields)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		task, err := reader.Update(ctx, id, input)
		if err == sql.ErrNoRows {
			writeError(w, http.StatusNotFound, "not_found", "task not found", nil)
			return
		}
		if err != nil {
			if constraintFields, ok := mapCreateTaskError(err); ok {
				writeError(w, http.StatusBadRequest, "validation_failed", "Check the task fields.", constraintFields)
				return
			}
			log.Printf("update task: %v", err)
			writeError(w, http.StatusInternalServerError, "internal_error", "unable to update task", nil)
			return
		}

		writeJSON(w, task)
	})
	mux.HandleFunc("DELETE /api/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := parseTaskPathID(r.PathValue("id"))
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid_task_id", "invalid task id", nil)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		deleted, err := reader.Delete(ctx, id)
		if err != nil {
			log.Printf("delete task: %v", err)
			writeError(w, http.StatusInternalServerError, "internal_error", "unable to delete task", nil)
			return
		}
		if !deleted {
			writeError(w, http.StatusNotFound, "not_found", "task not found", nil)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

func decodeTaskBodyObject(w http.ResponseWriter, body io.ReadCloser) (map[string]json.RawMessage, int, string, string) {
	limited := http.MaxBytesReader(w, body, maxTaskBodyBytes)
	defer limited.Close()

	dec := json.NewDecoder(limited)
	dec.UseNumber()
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, http.StatusRequestEntityTooLarge, "request_too_large", "Request body exceeds maximum size."
		}
		return nil, http.StatusBadRequest, "invalid_json", "Request body must contain valid JSON."
	}

	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, http.StatusRequestEntityTooLarge, "request_too_large", "Request body exceeds maximum size."
		}
		return nil, http.StatusBadRequest, "invalid_json", "Request body must contain a single JSON object."
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, http.StatusBadRequest, "invalid_json", "Request body must be a JSON object."
	}

	var rawFields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &rawFields); err != nil {
		return nil, http.StatusBadRequest, "invalid_json", "Request body must be a JSON object."
	}
	return rawFields, 0, "", ""
}

func validateCommonEditableFields(rawFields map[string]json.RawMessage, fields map[string]string) (string, *string, string, int) {
	var (
		title       string
		description *string
		priority    string
		assignedTo  int
	)

	rawTitle, hasTitle := rawFields["title"]
	if !hasTitle {
		fields["title"] = "Title is required."
	} else {
		var titleStr string
		if bytes.Equal(bytes.TrimSpace(rawTitle), []byte("null")) || json.Unmarshal(rawTitle, &titleStr) != nil || !utf8.ValidString(titleStr) {
			fields["title"] = "Title must be a string."
		} else if utf8.RuneCountInString(titleStr) > maxTitleRunes {
			fields["title"] = "Title must be 200 characters or fewer."
		} else {
			normalizedTitle := strings.TrimSpace(titleStr)
			if normalizedTitle == "" {
				fields["title"] = "Title is required."
			} else {
				title = normalizedTitle
			}
		}
	}

	if rawDesc, hasDesc := rawFields["description"]; hasDesc {
		var descStr string
		if bytes.Equal(bytes.TrimSpace(rawDesc), []byte("null")) || json.Unmarshal(rawDesc, &descStr) != nil || !utf8.ValidString(descStr) {
			fields["description"] = "Description must be a string."
		} else if utf8.RuneCountInString(descStr) > maxDescRunes {
			fields["description"] = "Description must be 2,000 characters or fewer."
		} else {
			description = &descStr
		}
	}

	rawPriority, hasPriority := rawFields["priority"]
	if !hasPriority {
		fields["priority"] = "Priority is required."
	} else {
		var priorityStr string
		if bytes.Equal(bytes.TrimSpace(rawPriority), []byte("null")) || json.Unmarshal(rawPriority, &priorityStr) != nil {
			fields["priority"] = "Priority must be low, medium, or high."
		} else if priorityStr != "low" && priorityStr != "medium" && priorityStr != "high" {
			fields["priority"] = "Priority must be low, medium, or high."
		} else {
			priority = priorityStr
		}
	}

	rawAssigned, hasAssigned := rawFields["assigned_to"]
	if !hasAssigned {
		fields["assigned_to"] = "Assignee is required."
	} else if assignedID, ok := parsePositivePostgresID(rawAssigned); !ok {
		fields["assigned_to"] = "Assignee must be a valid user ID."
	} else {
		assignedTo = assignedID
	}

	return title, description, priority, assignedTo
}

func decodeAndValidateCreateTask(w http.ResponseWriter, body io.ReadCloser) (CreateTaskInput, int, string, string, map[string]string) {
	rawFields, status, code, msg := decodeTaskBodyObject(w, body)
	if status != 0 {
		return CreateTaskInput{}, status, code, msg, nil
	}

	allowedKeys := map[string]bool{
		"title":       true,
		"description": true,
		"priority":    true,
		"assigned_to": true,
		"created_by":  true,
	}
	fields := make(map[string]string)
	for key := range rawFields {
		if !allowedKeys[key] {
			fields[key] = "Field is not allowed when creating a task."
		}
	}

	var input CreateTaskInput
	input.Title, input.Description, input.Priority, input.AssignedTo = validateCommonEditableFields(rawFields, fields)

	rawCreatedBy, hasCreatedBy := rawFields["created_by"]
	if !hasCreatedBy {
		fields["created_by"] = "Creator is required."
	} else if createdByID, ok := parsePositivePostgresID(rawCreatedBy); !ok {
		fields["created_by"] = "Creator must be a valid user ID."
	} else {
		input.CreatedBy = createdByID
	}

	if len(fields) > 0 {
		return CreateTaskInput{}, http.StatusBadRequest, "validation_failed", "Check the task fields.", fields
	}

	return input, 0, "", "", nil
}

func decodeAndValidateUpdateTask(w http.ResponseWriter, body io.ReadCloser) (UpdateTaskInput, int, string, string, map[string]string) {
	rawFields, status, code, msg := decodeTaskBodyObject(w, body)
	if status != 0 {
		return UpdateTaskInput{}, status, code, msg, nil
	}

	allowedKeys := map[string]bool{
		"title":       true,
		"description": true,
		"priority":    true,
		"assigned_to": true,
		"status":      true,
	}
	fields := make(map[string]string)
	for key := range rawFields {
		if !allowedKeys[key] {
			fields[key] = "Field is not allowed when updating a task."
		}
	}

	var input UpdateTaskInput
	input.Title, input.Description, input.Priority, input.AssignedTo = validateCommonEditableFields(rawFields, fields)

	rawStatus, hasStatus := rawFields["status"]
	if !hasStatus {
		fields["status"] = "Status is required."
	} else {
		var statusStr string
		if bytes.Equal(bytes.TrimSpace(rawStatus), []byte("null")) || json.Unmarshal(rawStatus, &statusStr) != nil {
			fields["status"] = "Status must be todo, in_progress, or done."
		} else if statusStr != "todo" && statusStr != "in_progress" && statusStr != "done" {
			fields["status"] = "Status must be todo, in_progress, or done."
		} else {
			input.Status = statusStr
		}
	}

	if len(fields) > 0 {
		return UpdateTaskInput{}, http.StatusBadRequest, "validation_failed", "Check the task fields.", fields
	}

	return input, 0, "", "", nil
}

func parsePositivePostgresID(raw json.RawMessage) (int, bool) {
	token := strings.TrimSpace(string(raw))
	if !positiveDecimalID.MatchString(token) {
		return 0, false
	}
	id, err := strconv.Atoi(token)
	if err != nil || id <= 0 || int64(id) > 2147483647 {
		return 0, false
	}
	return id, true
}

func mapCreateTaskError(err error) (map[string]string, bool) {
	var pqErr *pq.Error
	if !errors.As(err, &pqErr) {
		return nil, false
	}
	switch pqErr.Code {
	case "23503":
		constraint := pqErr.Constraint + " " + pqErr.Detail
		if strings.Contains(constraint, "assigned_to") {
			return map[string]string{"assigned_to": "Assigned user does not exist."}, true
		}
		if strings.Contains(constraint, "created_by") {
			return map[string]string{"created_by": "Creator user does not exist."}, true
		}
		return map[string]string{"assigned_to": "Referenced user does not exist."}, true
	case "23514":
		if strings.Contains(pqErr.Constraint, "title") {
			return map[string]string{"title": "Title is invalid."}, true
		}
		if strings.Contains(pqErr.Constraint, "description") {
			return map[string]string{"description": "Description must be 2,000 characters or fewer."}, true
		}
		if strings.Contains(pqErr.Constraint, "priority") {
			return map[string]string{"priority": "Priority must be low, medium, or high."}, true
		}
		if strings.Contains(pqErr.Constraint, "status") {
			return map[string]string{"status": "Status must be todo, in_progress, or done."}, true
		}
		return map[string]string{}, true
	default:
		return nil, false
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string, fields map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(APIError{
		Error:   code,
		Message: message,
		Fields:  fields,
	})
}

func taskDatabaseHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cs := os.Getenv("ConnectionString")
		if cs == "" {
			writeError(w, http.StatusInternalServerError, "internal_error", "database connection is not configured", nil)
			return
		}
		db, err := sql.Open("postgres", cs)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "unable to connect to database", nil)
			return
		}
		defer db.Close()
		taskHandlers(sqlTaskReader{db}).ServeHTTP(w, r)
	})
}
