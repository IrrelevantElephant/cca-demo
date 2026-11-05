-- Additive RecoverBoard migration: preserves existing application data and tables.
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(100) NOT NULL
);

INSERT INTO users (id, name, role) VALUES
    (1, 'Alice', 'Developer'),
    (2, 'Bob', 'Developer'),
    (3, 'Charlie', 'Team Lead')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role;
