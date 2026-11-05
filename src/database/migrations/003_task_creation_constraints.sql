-- Additive task length constraints for Slice 3 task creation.
-- Marked NOT VALID so historical rows are preserved without rewriting or deleting legacy data;
-- PostgreSQL enforces both constraints on all new INSERT and UPDATE writes.
-- To validate historical data after auditing legacy rows manually, run:
--   ALTER TABLE tasks VALIDATE CONSTRAINT tasks_title_max_length_check;
--   ALTER TABLE tasks VALIDATE CONSTRAINT tasks_description_max_length_check;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'tasks'::regclass
          AND conname = 'tasks_title_max_length_check'
    ) THEN
        ALTER TABLE tasks
            ADD CONSTRAINT tasks_title_max_length_check
            CHECK (char_length(title) <= 200) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'tasks'::regclass
          AND conname = 'tasks_description_max_length_check'
    ) THEN
        ALTER TABLE tasks
            ADD CONSTRAINT tasks_description_max_length_check
            CHECK (description IS NULL OR char_length(description) <= 2000) NOT VALID;
    END IF;
END $$;
