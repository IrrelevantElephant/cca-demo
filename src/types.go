package main

import "time"

type User struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

type Task struct {
	ID          int       `json:"id"`
	Title       string    `json:"title"`
	Description *string   `json:"description"`
	Status      string    `json:"status"`
	Priority    string    `json:"priority"`
	AssignedTo  int       `json:"assigned_to"`
	CreatedBy   int       `json:"created_by"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type CreateTaskInput struct {
	Title       string
	Description *string
	Priority    string
	AssignedTo  int
	CreatedBy   int
}

type UpdateTaskInput struct {
	Title       string
	Description *string
	Status      string
	Priority    string
	AssignedTo  int
}

type APIError struct {
	Error   string            `json:"error"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
}
