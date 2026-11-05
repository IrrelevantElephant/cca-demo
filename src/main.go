package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	_ "github.com/lib/pq"
)

func main() {
	log.SetOutput(os.Stdout)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	mux := http.NewServeMux()
	incidents := &incidentState{}
	mux.HandleFunc("GET /api/users", handleUsers)
	mux.HandleFunc("GET /api/demo/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]bool{"enabled": incidentEnabled()})
	})
	mux.Handle("/api/demo/break", http.HandlerFunc(incidents.trigger))
	taskHandler := incidents.taskGate(taskDatabaseHandler())
	mux.Handle("/api/tasks", taskHandler)
	mux.Handle("/api/tasks/", taskHandler)
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		if incidents.snapshot().Active {
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.Handle("/", http.FileServer(http.Dir("./web/dist")))
	log.Printf("listening on: %s", port)
	log.Fatal(http.ListenAndServe(":"+port, logAPICalls(mux)))
}

func logAPICalls(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.Path) < len("/api/") || r.URL.Path[:len("/api/")] != "/api/" {
			next.ServeHTTP(w, r)
			return
		}

		started := time.Now()
		response := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(response, r)
		log.Printf("api request method=%s path=%q status=%d duration=%s", r.Method, r.URL.Path, response.status, time.Since(started))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func handleUsers(w http.ResponseWriter, r *http.Request) {
	connectionString := os.Getenv("ConnectionString")
	if connectionString == "" {
		writeError(w, http.StatusInternalServerError, "internal_error", "database connection is not configured", nil)
		return
	}
	db, err := sql.Open("postgres", connectionString)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "unable to connect to database", nil)
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(r.Context(), `SELECT id, name, role FROM users ORDER BY id`)
	if err != nil {
		log.Printf("query users: %v", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "unable to retrieve users", nil)
		return
	}
	defer rows.Close()

	users := make([]User, 0)
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.ID, &user.Name, &user.Role); err != nil {
			log.Printf("scan user: %v", err)
			writeError(w, http.StatusInternalServerError, "internal_error", "unable to retrieve users", nil)
			return
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		log.Printf("iterate users: %v", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "unable to retrieve users", nil)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(users); err != nil {
		log.Printf("encode users: %v", err)
	}
}
