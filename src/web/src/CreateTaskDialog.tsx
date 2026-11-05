import { useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { wrapDialogFocus } from './dialogFocus';
import {
  codePointLength,
  createTask,
  maxDescriptionCodePoints,
  maxTitleCodePoints,
} from './taskApi';
import type { Task, TaskPriority, User } from './types';

type CreateTaskDialogProps = {
  creator: User;
  users: User[];
  onClose: () => void;
  onCreated: (task: Task) => void;
  onCheckBoard: () => Promise<boolean>;
};

export default function CreateTaskDialog({
  creator,
  users,
  onClose,
  onCreated,
  onCheckBoard,
}: CreateTaskDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const priorityRef = useRef<HTMLSelectElement | null>(null);
  const assigneeRef = useRef<HTMLSelectElement | null>(null);
  const submittingRef = useRef(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [assignedTo, setAssignedTo] = useState<string>(String(creator.id));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState('');
  const [uncertainSave, setUncertainSave] = useState(false);
  const [checkingBoard, setCheckingBoard] = useState(false);
  const [boardCheckNotice, setBoardCheckNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    titleInputRef.current?.focus();
    return () => {
      if (dialog?.open) {
        dialog.close();
      }
    };
  }, []);

  const closeDialog = () => {
    if (submittingRef.current) return;
    if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    wrapDialogFocus(event);
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!submittingRef.current) {
        closeDialog();
      }
    }
  };

  const handleTitleChange = (nextTitle: string) => {
    setTitle(nextTitle);
    setUncertainSave(false);
    setBoardCheckNotice('');
    setFieldErrors((prev) => {
      const next = { ...prev };
      if (codePointLength(nextTitle) > maxTitleCodePoints) {
        next.title = 'Title must be 200 characters or fewer.';
      } else if (next.title && nextTitle.trim().length > 0) {
        delete next.title;
      }
      return next;
    });
  };

  const handleDescriptionChange = (nextDescription: string) => {
    setDescription(nextDescription);
    setUncertainSave(false);
    setBoardCheckNotice('');
    setFieldErrors((prev) => {
      const next = { ...prev };
      if (codePointLength(nextDescription) > maxDescriptionCodePoints) {
        next.description = 'Description must be 2,000 characters or fewer.';
      } else if (next.description) {
        delete next.description;
      }
      return next;
    });
  };

  const focusFirstInvalid = (errors: Record<string, string>) => {
    if (errors.title) titleInputRef.current?.focus();
    else if (errors.description) descriptionRef.current?.focus();
    else if (errors.priority) priorityRef.current?.focus();
    else if (errors.assigned_to) assigneeRef.current?.focus();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;

    const errors: Record<string, string> = {};
    if (codePointLength(title) > maxTitleCodePoints) {
      errors.title = 'Title must be 200 characters or fewer.';
    } else if (!title.trim()) {
      errors.title = 'Title is required.';
    }

    if (codePointLength(description) > maxDescriptionCodePoints) {
      errors.description = 'Description must be 2,000 characters or fewer.';
    }

    if (!['low', 'medium', 'high'].includes(priority)) {
      errors.priority = 'Priority must be low, medium, or high.';
    }

    const assigneeId = Number(assignedTo);
    if (!Number.isInteger(assigneeId) || assigneeId <= 0 || !users.some((u) => u.id === assigneeId)) {
      errors.assigned_to = 'Select a valid assignee.';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setGeneralError('Check the task fields.');
      setUncertainSave(false);
      focusFirstInvalid(errors);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setFieldErrors({});
    setGeneralError('');
    setUncertainSave(false);
    setBoardCheckNotice('');

    const result = await createTask({
      title: title.trim(),
      ...(description !== '' ? { description } : {}),
      priority,
      assigned_to: assigneeId,
      created_by: creator.id,
    });

    submittingRef.current = false;
    setSubmitting(false);

    if (result.kind === 'created') {
      if (dialogRef.current?.open) {
        dialogRef.current.close();
      }
      onCreated(result.task);
      return;
    }

    if (result.kind === 'rejected') {
      setFieldErrors(result.fields);
      setGeneralError(result.message);
      focusFirstInvalid(result.fields);
      return;
    }

    setUncertainSave(true);
    setGeneralError(result.message);
  };

  const handleCheckBoard = async () => {
    if (checkingBoard || submittingRef.current) return;
    setCheckingBoard(true);
    setBoardCheckNotice('');
    const ok = await onCheckBoard();
    setCheckingBoard(false);
    setBoardCheckNotice(
      ok
        ? 'Board refreshed. Check the To do column before submitting again.'
        : 'Board could not be refreshed right now.'
    );
  };

  const titleCount = codePointLength(title);
  const descriptionCount = codePointLength(description);

  return (
    <dialog
      ref={dialogRef}
      className="task-dialog"
      aria-labelledby="create-task-heading"
      onCancel={(event) => {
        event.preventDefault();
        if (!submittingRef.current) {
          closeDialog();
        }
      }}
      onKeyDown={handleKeyDown}
    >
      <form className="task-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
        <div className="dialog-header">
          <h2 id="create-task-heading">Create Task</h2>
          <p className="creating-as">
            Creating as <strong>{creator.name}</strong>
          </p>
        </div>

        {generalError && (
          <div className="dialog-alert" role="alert">
            <p>{generalError}</p>
            {uncertainSave && (
              <div className="uncertain-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleCheckBoard()}
                  disabled={checkingBoard || submitting}
                >
                  {checkingBoard ? 'Checking board…' : 'Check board'}
                </button>
                {boardCheckNotice && <p className="board-check-notice">{boardCheckNotice}</p>}
              </div>
            )}
          </div>
        )}

        <div className="form-field">
          <div className="field-label-row">
            <label htmlFor="task-title">Title</label>
            <span className="char-counter" aria-hidden="true">
              {titleCount}/{maxTitleCodePoints}
            </span>
          </div>
          <input
            ref={titleInputRef}
            id="task-title"
            name="title"
            type="text"
            required
            value={title}
            disabled={submitting}
            aria-invalid={Boolean(fieldErrors.title)}
            aria-describedby={fieldErrors.title ? 'task-title-error' : undefined}
            onChange={(event) => handleTitleChange(event.target.value)}
          />
          {fieldErrors.title && (
            <p id="task-title-error" className="field-error" aria-live="polite">
              {fieldErrors.title}
            </p>
          )}
        </div>

        <div className="form-field">
          <div className="field-label-row">
            <label htmlFor="task-description">Description</label>
            <span className="char-counter" aria-hidden="true">
              {descriptionCount}/{maxDescriptionCodePoints}
            </span>
          </div>
          <textarea
            ref={descriptionRef}
            id="task-description"
            name="description"
            rows={4}
            value={description}
            disabled={submitting}
            aria-invalid={Boolean(fieldErrors.description)}
            aria-describedby={fieldErrors.description ? 'task-description-error' : undefined}
            onChange={(event) => handleDescriptionChange(event.target.value)}
          />
          {fieldErrors.description && (
            <p id="task-description-error" className="field-error" aria-live="polite">
              {fieldErrors.description}
            </p>
          )}
        </div>

        <div className="form-row">
          <div className="form-field">
            <label htmlFor="task-priority">Priority</label>
            <select
              ref={priorityRef}
              id="task-priority"
              name="priority"
              value={priority}
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.priority)}
              aria-describedby={fieldErrors.priority ? 'task-priority-error' : undefined}
              onChange={(event) => setPriority(event.target.value as TaskPriority)}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            {fieldErrors.priority && (
              <p id="task-priority-error" className="field-error" aria-live="polite">
                {fieldErrors.priority}
              </p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="task-assignee">Assignee</label>
            <select
              ref={assigneeRef}
              id="task-assignee"
              name="assigned_to"
              value={assignedTo}
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.assigned_to)}
              aria-describedby={fieldErrors.assigned_to ? 'task-assignee-error' : undefined}
              onChange={(event) => setAssignedTo(event.target.value)}
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
            {fieldErrors.assigned_to && (
              <p id="task-assignee-error" className="field-error" aria-live="polite">
                {fieldErrors.assigned_to}
              </p>
            )}
          </div>
        </div>

        <div className="dialog-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={closeDialog}
            disabled={submitting}
          >
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create Task'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
