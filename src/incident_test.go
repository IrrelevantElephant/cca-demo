package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIncidentActivationIsLatchedAndTasksReturnUnavailable(t *testing.T) {
	t.Setenv("DEMO_INCIDENT_ENABLED", "true")
	state := &incidentState{}
	before := state.snapshot()
	if before.Active {
		t.Fatal("incident active on startup")
	}
	recorder := httptest.NewRecorder()
	state.trigger(recorder, httptest.NewRequest("POST", "/api/demo/break", nil))
	if recorder.Code != 202 {
		t.Fatalf("trigger status = %d", recorder.Code)
	}
	var response map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil || response["message"] != "Incident simulation activated" {
		t.Fatalf("unexpected response: %s (%v)", recorder.Body.String(), err)
	}
	first := state.snapshot()
	again := httptest.NewRecorder()
	state.trigger(again, httptest.NewRequest("POST", "/api/demo/break", nil))
	if again.Code != 202 || state.snapshot() != first {
		t.Fatal("repeated trigger altered incident state")
	}
	called := false
	handler := state.taskGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	failed := httptest.NewRecorder()
	handler.ServeHTTP(failed, httptest.NewRequest("GET", "/api/tasks", nil))
	if failed.Code != 503 || called {
		t.Fatalf("task gate status=%d called=%v", failed.Code, called)
	}
}

func TestIncidentTriggerDisabledByDefault(t *testing.T) {
	t.Setenv("DEMO_INCIDENT_ENABLED", "false")
	state := &incidentState{}
	response := httptest.NewRecorder()
	state.trigger(response, httptest.NewRequest("POST", "/api/demo/break", nil))
	if response.Code != 404 || state.snapshot().Active {
		t.Fatalf("disabled trigger status=%d active=%v", response.Code, state.snapshot().Active)
	}
}
