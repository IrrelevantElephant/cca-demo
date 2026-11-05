package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lib/pq"
)

type fakeTaskReader struct {
	tasks                                            []Task
	task                                             Task
	createdTask                                      Task
	updatedTask                                      Task
	deleted                                          bool
	listErr, getErr, createErr, updateErr, deleteErr error
	gotID                                            int
	gotInput                                         CreateTaskInput
	gotUpdateID                                      int
	gotUpdateInput                                   UpdateTaskInput
	gotDeleteID                                      int
	createCalls                                      int
	updateCalls                                      int
	deleteCalls                                      int
}

func (f *fakeTaskReader) List(context.Context) ([]Task, error) { return f.tasks, f.listErr }
func (f *fakeTaskReader) Get(_ context.Context, id int) (Task, error) {
	f.gotID = id
	return f.task, f.getErr
}
func (f *fakeTaskReader) Create(_ context.Context, input CreateTaskInput) (Task, error) {
	f.createCalls++
	f.gotInput = input
	if f.createErr != nil {
		return Task{}, f.createErr
	}
	if f.createdTask.ID != 0 {
		return f.createdTask, nil
	}
	now := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	return Task{
		ID:          42,
		Title:       input.Title,
		Description: input.Description,
		Status:      "todo",
		Priority:    input.Priority,
		AssignedTo:  input.AssignedTo,
		CreatedBy:   input.CreatedBy,
		CreatedAt:   now,
		UpdatedAt:   now,
	}, nil
}
func (f *fakeTaskReader) Update(_ context.Context, id int, input UpdateTaskInput) (Task, error) {
	f.updateCalls++
	f.gotUpdateID = id
	f.gotUpdateInput = input
	if f.updateErr != nil {
		return Task{}, f.updateErr
	}
	if f.updatedTask.ID != 0 {
		return f.updatedTask, nil
	}
	createdAt := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	updatedAt := time.Date(2025, 1, 2, 4, 5, 6, 0, time.UTC)
	return Task{
		ID:          id,
		Title:       input.Title,
		Description: input.Description,
		Status:      input.Status,
		Priority:    input.Priority,
		AssignedTo:  input.AssignedTo,
		CreatedBy:   1,
		CreatedAt:   createdAt,
		UpdatedAt:   updatedAt,
	}, nil
}
func (f *fakeTaskReader) Delete(_ context.Context, id int) (bool, error) {
	f.deleteCalls++
	f.gotDeleteID = id
	if f.deleteErr != nil {
		return false, f.deleteErr
	}
	return f.deleted, nil
}

func TestTaskHandlersListJSON(t *testing.T) {
	desc := "details"
	f := &fakeTaskReader{tasks: []Task{{ID: 9, Title: "Task", Description: &desc, Status: "todo", Priority: "high", AssignedTo: 1, CreatedBy: 2, CreatedAt: time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC), UpdatedAt: time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)}}}
	w := httptest.NewRecorder()
	taskHandlers(f).ServeHTTP(w, httptest.NewRequest("GET", "/api/tasks", nil))
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	body := w.Body.String()
	for _, part := range []string{`"id":9`, `"description":"details"`, `"assigned_to":1`, `"created_at":"2025-01-02T03:04:05Z"`} {
		if !strings.Contains(body, part) {
			t.Errorf("response missing %s: %s", part, body)
		}
	}
}

func TestTaskHandlersEmptyListAndErrors(t *testing.T) {
	f := &fakeTaskReader{tasks: []Task{}}
	w := httptest.NewRecorder()
	taskHandlers(f).ServeHTTP(w, httptest.NewRequest("GET", "/api/tasks", nil))
	if strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("expected array, got %s", w.Body.String())
	}
	f.listErr = errors.New("offline")
	w = httptest.NewRecorder()
	taskHandlers(f).ServeHTTP(w, httptest.NewRequest("GET", "/api/tasks", nil))
	if w.Code != 500 {
		t.Fatalf("expected 500, got %d", w.Code)
	}
	f.listErr = context.Canceled
	w = httptest.NewRecorder()
	taskHandlers(f).ServeHTTP(w, httptest.NewRequest("GET", "/api/tasks", nil))
	if w.Code != 500 {
		t.Fatalf("expected cancellation 500, got %d", w.Code)
	}
}

func TestTaskDetailIDs(t *testing.T) {
	f := &fakeTaskReader{task: Task{ID: 12, Title: "Task"}}
	h := taskHandlers(f)
	for _, id := range []string{"abc", "+1", "-1", "0", "2147483648", "999999999999999999999"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/api/tasks/"+id, nil))
		if w.Code != 400 {
			t.Errorf("%s: expected 400, got %d", id, w.Code)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/tasks/12", nil))
	if w.Code != 200 || f.gotID != 12 {
		t.Fatalf("status=%d id=%d", w.Code, f.gotID)
	}
	f.getErr = sql.ErrNoRows
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/tasks/12", nil))
	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestTaskCreateSuccessAndDescriptionHandling(t *testing.T) {
	f := &fakeTaskReader{}
	h := taskHandlers(f)

	req := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{"title":"  Ship Slice 3  ","description":"  Keep whitespace\nand newline  ","priority":"high","assigned_to":2,"created_by":1}`))
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Location"); got != "/api/tasks/42" {
		t.Fatalf("expected Location /api/tasks/42, got %q", got)
	}
	if got := w.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("expected application/json, got %q", got)
	}
	if f.gotInput.Title != "Ship Slice 3" {
		t.Fatalf("expected trimmed title, got %q", f.gotInput.Title)
	}
	if f.gotInput.Description == nil || *f.gotInput.Description != "  Keep whitespace\nand newline  " {
		t.Fatalf("expected preserved description whitespace, got %v", f.gotInput.Description)
	}

	// Omitted description stores NULL.
	req = httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{"title":"No description","priority":"medium","assigned_to":1,"created_by":1}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusCreated || f.gotInput.Description != nil {
		t.Fatalf("expected omitted description to be nil, status=%d desc=%v", w.Code, f.gotInput.Description)
	}

	// Explicit empty string description remains an empty string.
	req = httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{"title":"Empty description","description":"","priority":"low","assigned_to":1,"created_by":1}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusCreated || f.gotInput.Description == nil || *f.gotInput.Description != "" {
		t.Fatalf("expected empty string description to remain non-nil empty string, status=%d desc=%v", w.Code, f.gotInput.Description)
	}
}

func TestTaskCreateValidationAndBoundaries(t *testing.T) {
	f := &fakeTaskReader{}
	h := taskHandlers(f)

	// Exact 200-rune Unicode title and 2000-rune Unicode description pass.
	title200 := strings.Repeat("😀", 200)
	desc2000 := strings.Repeat("é", 1000) + strings.Repeat("🚀", 1000)
	validPayload, _ := json.Marshal(map[string]any{
		"title":       title200,
		"description": desc2000,
		"priority":    "medium",
		"assigned_to": 1,
		"created_by":  2,
	})
	req := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(string(validPayload)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 200/2000 rune Unicode boundary to succeed, got %d: %s", w.Code, w.Body.String())
	}

	beforeCalls := f.createCalls
	invalidPayloads := []string{
		`{}`,
		`[]`,
		`null`,
		`"string"`,
		`123`,
		`{bad json`,
		`{"title":"Valid","priority":"low","assigned_to":1,"created_by":1}{}`,
		`{"title":"","priority":"low","assigned_to":1,"created_by":1}`,
		`{"title":"   \t\n  ","priority":"low","assigned_to":1,"created_by":1}`,
		`{"title":null,"priority":"low","assigned_to":1,"created_by":1}`,
		`{"title":123,"priority":"low","assigned_to":1,"created_by":1}`,
		`{"title":"` + strings.Repeat("a", 201) + `","priority":"low","assigned_to":1,"created_by":1}`,
		`{"title":" ` + strings.Repeat("a", 200) + `","priority":"low","assigned_to":1,"created_by":1}`,
		`{"title":"` + strings.Repeat("😀", 201) + `","priority":"low","assigned_to":1,"created_by":1}`,
		`{"title":"Valid","description":null,"priority":"low","assigned_to":1,"created_by":1}`,
		`{"title":"Valid","description":42,"priority":"low","assigned_to":1,"created_by":1}`,
		`{"title":"Valid","description":"` + strings.Repeat("😀", 2001) + `","priority":"low","assigned_to":1,"created_by":1}`,
		`{"title":"Valid","priority":"urgent","assigned_to":1,"created_by":1}`,
		`{"title":"Valid","priority":null,"assigned_to":1,"created_by":1}`,
		`{"title":"Valid","priority":"low","assigned_to":0,"created_by":1}`,
		`{"title":"Valid","priority":"low","assigned_to":-1,"created_by":1}`,
		`{"title":"Valid","priority":"low","assigned_to":1.5,"created_by":1}`,
		`{"title":"Valid","priority":"low","assigned_to":1.0,"created_by":1}`,
		`{"title":"Valid","priority":"low","assigned_to":1e1,"created_by":1}`,
		`{"title":"Valid","priority":"low","assigned_to":"1","created_by":1}`,
		`{"title":"Valid","priority":"low","assigned_to":null,"created_by":1}`,
		`{"title":"Valid","priority":"low","assigned_to":2147483648,"created_by":1}`,
		`{"title":"Valid","priority":"low","assigned_to":1,"created_by":0}`,
		`{"title":"Valid","priority":"low","assigned_to":1,"created_by":-5}`,
		`{"title":"Valid","priority":"low","assigned_to":1,"created_by":1.0}`,
		`{"title":"Valid","priority":"low","assigned_to":1,"created_by":2147483648}`,
		`{"title":"Valid","priority":"low","assigned_to":1,"created_by":1,"status":"todo"}`,
		`{"title":"Valid","priority":"low","assigned_to":1,"created_by":1,"id":10}`,
		`{"title":"Valid","priority":"low","assigned_to":1,"created_by":1,"created_at":"2025-01-01T00:00:00Z"}`,
		`{"title":"Valid","priority":"low","assigned_to":1,"created_by":1,"updated_at":"2025-01-01T00:00:00Z"}`,
		`{"title":"Valid","priority":"low","assigned_to":1,"created_by":1,"unknown":true}`,
	}
	for _, body := range invalidPayloads {
		req := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("payload %s: expected 400, got %d (%s)", body, w.Code, w.Body.String())
		}
	}
	if f.createCalls != beforeCalls {
		t.Fatalf("expected 0 store Create calls on invalid payloads, got %d", f.createCalls-beforeCalls)
	}

	// Missing/unsupported Content-Type returns 415.
	req = httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{"title":"Valid","priority":"low","assigned_to":1,"created_by":1}`))
	req.Header.Set("Content-Type", "text/plain")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415 for text/plain, got %d", w.Code)
	}

	// Oversized body returns 413.
	req = httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{"title":"Valid","description":"`+strings.Repeat("x", maxTaskBodyBytes+100)+`","priority":"low","assigned_to":1,"created_by":1}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized body, got %d", w.Code)
	}
}

func TestTaskCreateStorageErrorMapping(t *testing.T) {
	f := &fakeTaskReader{}
	h := taskHandlers(f)
	validBody := `{"title":"Valid","priority":"low","assigned_to":99,"created_by":88}`

	cases := []struct {
		err        error
		wantStatus int
		wantField  string
	}{
		{
			err:        &pq.Error{Code: "23503", Constraint: "tasks_assigned_to_fkey"},
			wantStatus: http.StatusBadRequest,
			wantField:  "assigned_to",
		},
		{
			err:        &pq.Error{Code: "23503", Constraint: "tasks_created_by_fkey"},
			wantStatus: http.StatusBadRequest,
			wantField:  "created_by",
		},
		{
			err:        &pq.Error{Code: "23514", Constraint: "tasks_title_max_length_check"},
			wantStatus: http.StatusBadRequest,
			wantField:  "title",
		},
		{
			err:        errors.New("pq: secret password@host connection failure"),
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tc := range cases {
		f.createErr = tc.err
		req := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(validBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != tc.wantStatus {
			t.Fatalf("err=%v: expected %d, got %d (%s)", tc.err, tc.wantStatus, w.Code, w.Body.String())
		}
		var apiErr APIError
		if err := json.Unmarshal(w.Body.Bytes(), &apiErr); err != nil {
			t.Fatalf("unmarshal error body: %v", err)
		}
		if tc.wantField != "" && apiErr.Fields[tc.wantField] == "" {
			t.Fatalf("expected field error for %q, got %+v", tc.wantField, apiErr)
		}
		if tc.wantStatus == http.StatusInternalServerError && strings.Contains(w.Body.String(), "secret") {
			t.Fatalf("leaked internal error details: %s", w.Body.String())
		}
	}
}

func TestTaskUpdateSuccessTransitionsAndDescriptionHandling(t *testing.T) {
	f := &fakeTaskReader{}
	h := taskHandlers(f)

	for _, statusVal := range []string{"todo", "in_progress", "done"} {
		for _, priorityVal := range []string{"low", "medium", "high"} {
			req := httptest.NewRequest("PUT", "/api/tasks/7", strings.NewReader(`{"title":"  Updated title  ","description":"  Line 1\nLine 2  ","status":"`+statusVal+`","priority":"`+priorityVal+`","assigned_to":3}`))
			req.Header.Set("Content-Type", "application/json; charset=utf-8")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)

			if w.Code != http.StatusOK {
				t.Fatalf("status=%s priority=%s: expected 200, got %d: %s", statusVal, priorityVal, w.Code, w.Body.String())
			}
			if f.gotUpdateID != 7 {
				t.Fatalf("expected update id 7, got %d", f.gotUpdateID)
			}
			if f.gotUpdateInput.Title != "Updated title" {
				t.Fatalf("expected trimmed title, got %q", f.gotUpdateInput.Title)
			}
			if f.gotUpdateInput.Description == nil || *f.gotUpdateInput.Description != "  Line 1\nLine 2  " {
				t.Fatalf("expected preserved description whitespace, got %v", f.gotUpdateInput.Description)
			}
			if f.gotUpdateInput.Status != statusVal || f.gotUpdateInput.Priority != priorityVal || f.gotUpdateInput.AssignedTo != 3 {
				t.Fatalf("unexpected update input: %+v", f.gotUpdateInput)
			}
			var returned Task
			if err := json.Unmarshal(w.Body.Bytes(), &returned); err != nil {
				t.Fatalf("unmarshal response: %v", err)
			}
			if returned.ID != 7 || returned.CreatedBy != 1 || !returned.UpdatedAt.After(returned.CreatedAt) {
				t.Fatalf("unexpected returned task: %+v", returned)
			}
		}
	}

	// Omitted description clears to nil.
	req := httptest.NewRequest("PUT", "/api/tasks/7", strings.NewReader(`{"title":"Cleared desc","status":"in_progress","priority":"medium","assigned_to":2}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK || f.gotUpdateInput.Description != nil {
		t.Fatalf("expected omitted description to be nil, status=%d desc=%v", w.Code, f.gotUpdateInput.Description)
	}

	// Explicit empty-string description remains non-nil empty string.
	req = httptest.NewRequest("PUT", "/api/tasks/7", strings.NewReader(`{"title":"Empty desc","description":"","status":"done","priority":"low","assigned_to":1}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK || f.gotUpdateInput.Description == nil || *f.gotUpdateInput.Description != "" {
		t.Fatalf("expected empty-string description to remain non-nil empty string, status=%d desc=%v", w.Code, f.gotUpdateInput.Description)
	}
}

func TestTaskUpdateValidationIDsAndImmutableFields(t *testing.T) {
	f := &fakeTaskReader{}
	h := taskHandlers(f)

	// Exact 200-rune Unicode title and 2000-rune Unicode description pass.
	title200 := strings.Repeat("😀", 200)
	desc2000 := strings.Repeat("é", 1000) + strings.Repeat("🚀", 1000)
	validPayload, _ := json.Marshal(map[string]any{
		"title":       title200,
		"description": desc2000,
		"status":      "in_progress",
		"priority":    "high",
		"assigned_to": 2,
	})
	req := httptest.NewRequest("PUT", "/api/tasks/15", strings.NewReader(string(validPayload)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200/2000 rune Unicode boundary to succeed, got %d: %s", w.Code, w.Body.String())
	}

	beforeCalls := f.updateCalls

	// Invalid path IDs never invoke Update.
	for _, badID := range []string{"abc", "+1", "-1", "0", "1.0", "1e1", "2147483648", "999999999999999999999"} {
		req := httptest.NewRequest("PUT", "/api/tasks/"+badID, strings.NewReader(string(validPayload)))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("id %s: expected 400, got %d", badID, w.Code)
		}
	}

	invalidPayloads := []string{
		`{}`,
		`[]`,
		`null`,
		`"string"`,
		`123`,
		`{bad json`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":1}{}`,
		`{"status":"todo","priority":"low","assigned_to":1}`,
		`{"title":"Valid","priority":"low","assigned_to":1}`,
		`{"title":"Valid","status":"todo","assigned_to":1}`,
		`{"title":"Valid","status":"todo","priority":"low"}`,
		`{"title":"","status":"todo","priority":"low","assigned_to":1}`,
		`{"title":"   \t\n  ","status":"todo","priority":"low","assigned_to":1}`,
		`{"title":null,"status":"todo","priority":"low","assigned_to":1}`,
		`{"title":123,"status":"todo","priority":"low","assigned_to":1}`,
		`{"title":"` + strings.Repeat("a", 201) + `","status":"todo","priority":"low","assigned_to":1}`,
		`{"title":" ` + strings.Repeat("a", 200) + `","status":"todo","priority":"low","assigned_to":1}`,
		`{"title":"` + strings.Repeat("😀", 201) + `","status":"todo","priority":"low","assigned_to":1}`,
		`{"title":"Valid","description":null,"status":"todo","priority":"low","assigned_to":1}`,
		`{"title":"Valid","description":42,"status":"todo","priority":"low","assigned_to":1}`,
		`{"title":"Valid","description":"` + strings.Repeat("😀", 2001) + `","status":"todo","priority":"low","assigned_to":1}`,
		`{"title":"Valid","status":"blocked","priority":"low","assigned_to":1}`,
		`{"title":"Valid","status":"TODO","priority":"low","assigned_to":1}`,
		`{"title":"Valid","status":null,"priority":"low","assigned_to":1}`,
		`{"title":"Valid","status":1,"priority":"low","assigned_to":1}`,
		`{"title":"Valid","status":"todo","priority":"urgent","assigned_to":1}`,
		`{"title":"Valid","status":"todo","priority":null,"assigned_to":1}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":0}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":-1}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":1.5}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":1.0}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":1e1}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":"1"}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":null}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":2147483648}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":1,"id":15}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":1,"created_by":1}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":1,"created_at":"2025-01-02T03:04:05Z"}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":1,"updated_at":"2025-01-02T03:04:05Z"}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":1,"seed_key":"recoverboard:slice2:01"}`,
		`{"title":"Valid","status":"todo","priority":"low","assigned_to":1,"unknown":true}`,
	}
	for _, body := range invalidPayloads {
		req := httptest.NewRequest("PUT", "/api/tasks/15", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("payload %s: expected 400, got %d (%s)", body, w.Code, w.Body.String())
		}
	}
	if f.updateCalls != beforeCalls {
		t.Fatalf("expected 0 store Update calls on invalid requests, got %d", f.updateCalls-beforeCalls)
	}

	// Missing/unsupported Content-Type returns 415.
	req = httptest.NewRequest("PUT", "/api/tasks/15", strings.NewReader(`{"title":"Valid","status":"todo","priority":"low","assigned_to":1}`))
	req.Header.Set("Content-Type", "text/plain")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415 for text/plain, got %d", w.Code)
	}

	// Oversized body returns 413.
	req = httptest.NewRequest("PUT", "/api/tasks/15", strings.NewReader(`{"title":"Valid","description":"`+strings.Repeat("x", maxTaskBodyBytes+100)+`","status":"todo","priority":"low","assigned_to":1}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized body, got %d", w.Code)
	}
}

func TestTaskUpdateNotFoundAndStorageErrorMapping(t *testing.T) {
	f := &fakeTaskReader{}
	h := taskHandlers(f)
	validBody := `{"title":"Valid","status":"in_progress","priority":"low","assigned_to":99}`

	cases := []struct {
		err        error
		wantStatus int
		wantField  string
	}{
		{
			err:        sql.ErrNoRows,
			wantStatus: http.StatusNotFound,
		},
		{
			err:        &pq.Error{Code: "23503", Constraint: "tasks_assigned_to_fkey"},
			wantStatus: http.StatusBadRequest,
			wantField:  "assigned_to",
		},
		{
			err:        &pq.Error{Code: "23514", Constraint: "tasks_status_check"},
			wantStatus: http.StatusBadRequest,
			wantField:  "status",
		},
		{
			err:        errors.New("pq: secret password@host connection failure"),
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tc := range cases {
		f.updateErr = tc.err
		req := httptest.NewRequest("PUT", "/api/tasks/15", strings.NewReader(validBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != tc.wantStatus {
			t.Fatalf("err=%v: expected %d, got %d (%s)", tc.err, tc.wantStatus, w.Code, w.Body.String())
		}
		var apiErr APIError
		if err := json.Unmarshal(w.Body.Bytes(), &apiErr); err != nil {
			t.Fatalf("unmarshal error body: %v", err)
		}
		if tc.wantField != "" && apiErr.Fields[tc.wantField] == "" {
			t.Fatalf("expected field error for %q, got %+v", tc.wantField, apiErr)
		}
		if tc.wantStatus == http.StatusInternalServerError && strings.Contains(w.Body.String(), "secret") {
			t.Fatalf("leaked internal error details: %s", w.Body.String())
		}
	}
}

func TestTaskDeleteSuccessNotFoundInvalidIDsAndErrors(t *testing.T) {
	f := &fakeTaskReader{deleted: true}
	h := taskHandlers(f)

	// Successful DELETE returns 204 with zero response bytes and no required body/Content-Type.
	req := httptest.NewRequest("DELETE", "/api/tasks/19", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d (%s)", w.Code, w.Body.String())
	}
	if w.Body.Len() != 0 {
		t.Fatalf("expected empty 204 body, got %q", w.Body.String())
	}
	if f.gotDeleteID != 19 || f.deleteCalls != 1 {
		t.Fatalf("expected Delete(19) called once, got id=%d calls=%d", f.gotDeleteID, f.deleteCalls)
	}

	// Missing or already-deleted task returns 404 JSON.
	f.deleted = false
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/tasks/19", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on missing task, got %d (%s)", w.Code, w.Body.String())
	}
	var notFoundErr APIError
	if err := json.Unmarshal(w.Body.Bytes(), &notFoundErr); err != nil {
		t.Fatalf("unmarshal 404 error: %v", err)
	}
	if notFoundErr.Error != "not_found" || notFoundErr.Message != "task not found" {
		t.Fatalf("unexpected 404 error body: %+v", notFoundErr)
	}

	// Invalid IDs return 400 and never invoke store Delete.
	beforeCalls := f.deleteCalls
	for _, badID := range []string{"abc", "+1", "-1", "0", "1.0", "1e1", "2147483648", "999999999999999999999"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/tasks/"+badID, nil))
		if w.Code != http.StatusBadRequest {
			t.Errorf("id %s: expected 400, got %d (%s)", badID, w.Code, w.Body.String())
		}
		var badErr APIError
		if err := json.Unmarshal(w.Body.Bytes(), &badErr); err != nil {
			t.Fatalf("id %s: unmarshal 400 error: %v", badID, err)
		}
		if badErr.Error != "invalid_task_id" {
			t.Errorf("id %s: expected invalid_task_id, got %+v", badID, badErr)
		}
	}
	if f.deleteCalls != beforeCalls {
		t.Fatalf("expected 0 Delete calls on invalid IDs, got %d", f.deleteCalls-beforeCalls)
	}

	// Collection DELETE /api/tasks remains 405 Method Not Allowed.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/tasks", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for DELETE /api/tasks, got %d", w.Code)
	}
	if f.deleteCalls != beforeCalls {
		t.Fatalf("expected 0 Delete calls on collection DELETE, got %d", f.deleteCalls-beforeCalls)
	}

	// Store errors return generic 500 JSON without leaking details.
	f.deleteErr = errors.New("pq: secret password@host delete failure")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/tasks/19", nil))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on store error, got %d", w.Code)
	}
	if strings.Contains(w.Body.String(), "secret") {
		t.Fatalf("leaked internal error details: %s", w.Body.String())
	}
	var internalErr APIError
	if err := json.Unmarshal(w.Body.Bytes(), &internalErr); err != nil {
		t.Fatalf("unmarshal 500 error: %v", err)
	}
	if internalErr.Error != "internal_error" || internalErr.Message != "unable to delete task" {
		t.Fatalf("unexpected 500 error body: %+v", internalErr)
	}
}
