package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const incidentErrorCode = "TASK_SERVICE_STATE_CORRUPTED"

type incidentSnapshot struct {
	Active      bool
	ActivatedAt time.Time
	IncidentID  string
}
type incidentState struct {
	mu    sync.RWMutex
	value incidentSnapshot
}

func (s *incidentState) activate() (incidentSnapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.value.Active {
		return s.value, false
	}
	idBytes := make([]byte, 8)
	if _, err := rand.Read(idBytes); err != nil {
		copy(idBytes, []byte(time.Now().Format("150405.000000000")))
	}
	s.value = incidentSnapshot{Active: true, ActivatedAt: time.Now().UTC(), IncidentID: "incident-" + hex.EncodeToString(idBytes)}
	return s.value, true
}
func (s *incidentState) snapshot() incidentSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.value
}

func incidentEnabled() bool { return strings.EqualFold(os.Getenv("DEMO_INCIDENT_ENABLED"), "true") }

func (s *incidentState) trigger(w http.ResponseWriter, r *http.Request) {
	if !incidentEnabled() {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// This endpoint is only suitable behind the demo deployment's authenticated/private access controls.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": "Incident simulation activated"})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	state, activated := s.activate()
	if activated {
		slog.Error("Task service entered a non-recoverable in-memory state", "event", "demo_incident_activated", "incident_id", state.IncidentID, "component", "task_service", "error_code", incidentErrorCode, "activated_at", state.ActivatedAt, "recovery_required", true)
		slog.Error("Task service runtime state cannot be reconstructed in the current process. Application service restart required to reinitialise the component.", "event", "task_service_recovery_diagnostic", "incident_id", state.IncidentID, "component", "task_service", "error_code", incidentErrorCode, "recoverable_in_process", false, "recovery_action", "restart_application_service")
	}
}

func (s *incidentState) taskGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := s.snapshot()
		if state.Active {
			slog.Error("Task service is unable to process requests because its internal runtime state is invalid", "event", "task_service_request_failed", "incident_id", state.IncidentID, "component", "task_service", "error_code", incidentErrorCode, "http_status", http.StatusServiceUnavailable)
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Tasks are temporarily unavailable. Please try again.", nil)
			return
		}
		next.ServeHTTP(w, r)
	})
}
