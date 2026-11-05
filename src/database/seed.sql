-- Idempotently ensure the predefined RecoverBoard users exist.
INSERT INTO users (id, name, role) VALUES
    (1, 'Alice', 'Developer'),
    (2, 'Bob', 'Developer'),
    (3, 'Charlie', 'Team Lead')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role;
