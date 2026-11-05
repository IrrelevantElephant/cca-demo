package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTaskNilListIsArray(t *testing.T) {
	w := httptest.NewRecorder()
	taskHandlers(&fakeTaskReader{}).ServeHTTP(w, httptest.NewRequest("GET", "/api/tasks", nil))
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("%d: %s", w.Code, w.Body.String())
	}
}

func TestTaskDetailContractAndGenericErrors(t *testing.T) {
	f := &fakeTaskReader{task: Task{ID: 1, Title: "Task"}}
	w := httptest.NewRecorder()
	taskHandlers(f).ServeHTTP(w, httptest.NewRequest("GET", "/api/tasks/1", nil))
	var value map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	if len(value) != 9 || value["description"] != nil {
		t.Fatalf("unexpected shape: %v", value)
	}
	for _, err := range []error{errors.New("private database details"), context.Canceled, context.DeadlineExceeded} {
		f.getErr = err
		w = httptest.NewRecorder()
		taskHandlers(f).ServeHTTP(w, httptest.NewRequest("GET", "/api/tasks/1", nil))
		if w.Code != 500 || strings.Contains(w.Body.String(), err.Error()) {
			t.Fatalf("%d: %s", w.Code, w.Body.String())
		}
		f.createErr = err
		w = httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{"title":"Task","priority":"low","assigned_to":1,"created_by":1}`))
		req.Header.Set("Content-Type", "application/json")
		taskHandlers(f).ServeHTTP(w, req)
		if w.Code != 500 || strings.Contains(w.Body.String(), err.Error()) {
			t.Fatalf("POST %d: %s", w.Code, w.Body.String())
		}
		f.updateErr = err
		w = httptest.NewRecorder()
		req = httptest.NewRequest("PUT", "/api/tasks/1", strings.NewReader(`{"title":"Task","status":"todo","priority":"low","assigned_to":1}`))
		req.Header.Set("Content-Type", "application/json")
		taskHandlers(f).ServeHTTP(w, req)
		if w.Code != 500 || strings.Contains(w.Body.String(), err.Error()) {
			t.Fatalf("PUT %d: %s", w.Code, w.Body.String())
		}
		f.deleteErr = err
		w = httptest.NewRecorder()
		taskHandlers(f).ServeHTTP(w, httptest.NewRequest("DELETE", "/api/tasks/1", nil))
		if w.Code != 500 || strings.Contains(w.Body.String(), err.Error()) {
			t.Fatalf("DELETE %d: %s", w.Code, w.Body.String())
		}
	}
}

type contextTaskReader struct{ t *testing.T }

func (r contextTaskReader) List(ctx context.Context) ([]Task, error) {
	if _, ok := ctx.Deadline(); !ok {
		r.t.Error("missing query deadline")
	}
	if ctx.Err() != context.Canceled {
		r.t.Error("request cancellation not propagated")
	}
	return nil, ctx.Err()
}
func (r contextTaskReader) Get(ctx context.Context, _ int) (Task, error) {
	_, err := r.List(ctx)
	return Task{}, err
}
func (r contextTaskReader) Create(ctx context.Context, _ CreateTaskInput) (Task, error) {
	_, err := r.List(ctx)
	return Task{}, err
}
func (r contextTaskReader) Update(ctx context.Context, _ int, _ UpdateTaskInput) (Task, error) {
	_, err := r.List(ctx)
	return Task{}, err
}
func (r contextTaskReader) Delete(ctx context.Context, _ int) (bool, error) {
	_, err := r.List(ctx)
	return false, err
}
func TestTaskRequestContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, path := range []string{"/api/tasks", "/api/tasks/1"} {
		w := httptest.NewRecorder()
		taskHandlers(contextTaskReader{t}).ServeHTTP(w, httptest.NewRequest("GET", path, nil).WithContext(ctx))
		if w.Code != 500 {
			t.Fatalf("unexpected status: %d", w.Code)
		}
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{"title":"Task","priority":"low","assigned_to":1,"created_by":1}`)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	taskHandlers(contextTaskReader{t}).ServeHTTP(w, req)
	if w.Code != 500 {
		t.Fatalf("unexpected POST status: %d", w.Code)
	}
	w = httptest.NewRecorder()
	req = httptest.NewRequest("PUT", "/api/tasks/1", strings.NewReader(`{"title":"Task","status":"todo","priority":"low","assigned_to":1}`)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	taskHandlers(contextTaskReader{t}).ServeHTTP(w, req)
	if w.Code != 500 {
		t.Fatalf("unexpected PUT status: %d", w.Code)
	}
	w = httptest.NewRecorder()
	taskHandlers(contextTaskReader{t}).ServeHTTP(w, httptest.NewRequest("DELETE", "/api/tasks/1", nil).WithContext(ctx))
	if w.Code != 500 {
		t.Fatalf("unexpected DELETE status: %d", w.Code)
	}
}
