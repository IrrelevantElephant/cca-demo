import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { wrapDialogFocus } from './dialogFocus';
import {
  codePointLength,
  deleteTask,
  fetchTask,
  maxDescriptionCodePoints,
  maxTitleCodePoints,
  updateTask,
} from './taskApi';
import type { Task, TaskPriority, TaskStatus, User } from './types';

type TaskDetailsDialogProps = {
  taskId: number;
  users: User[];
  onClose: () => void;
  onSaved: (task: Task) => void;
  onDeleted: (taskId: number) => void;
  onTaskAlreadyGone: (taskId: number) => void;
  onTaskLoaded: (task: Task) => void;
  onRefreshBoard: () => Promise<boolean>;
};

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC');
}

export default function TaskDetailsDialog({
  taskId,
  users,
  onClose,
  onSaved,
  onDeleted,
  onTaskAlreadyGone,
  onTaskLoaded,
  onRefreshBoard,
}: TaskDetailsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const statusRef = useRef<HTMLSelectElement | null>(null);
  const priorityRef = useRef<HTMLSelectElement | null>(null);
  const assigneeRef = useRef<HTMLSelectElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cancelDeleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const submittingRef = useRef(false);
  const draftInitializedRef = useRef(false);
  const shouldFocusTitleRef = useRef(false);
  const shouldFocusDeleteTriggerRef = useRef(false);

  const [loadingDetail, setLoadingDetail] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [taskGone, setTaskGone] = useState(false);
  const [loadedTask, setLoadedTask] = useState<Task | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [assignedTo, setAssignedTo] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState('');
  const [uncertainSave, setUncertainSave] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileNotice, setReconcileNotice] = useState('');
  const [reconciledServerTask, setReconciledServerTask] = useState<Task | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [uncertainDelete, setUncertainDelete] = useState(false);
  const [deleteReconciling, setDeleteReconciling] = useState(false);
  const [deleteReconcileNotice, setDeleteReconcileNotice] = useState('');

  const people = useMemo(() => new Map(users.map((user) => [user.id, user.name])), [users]);
  const usersRef = useRef(users);
  usersRef.current = users;
  const onTaskLoadedRef = useRef(onTaskLoaded);
  onTaskLoadedRef.current = onTaskLoaded;

  const applyTaskToDraft = useCallback((task: Task, currentUsers: User[]) => {
    setLoadedTask(task);
    setTitle(task.title);
    setDescription(task.description ?? '');
    setStatus(task.status);
    setPriority(task.priority);
    setAssignedTo(currentUsers.some((u) => u.id === task.assigned_to) ? String(task.assigned_to) : '');
    setFieldErrors({});
    setGeneralError('');
    setUncertainSave(false);
    setReconcileNotice('');
    setReconciledServerTask(null);
  }, []);

  const loadDetail = useCallback(
    async (signal?: AbortSignal) => {
      setLoadingDetail(true);
      setLoadError('');
      const result = await fetchTask(taskId, signal);
      if (signal?.aborted) return;

      if (result.kind === 'ok') {
        onTaskLoadedRef.current(result.task);
        if (!draftInitializedRef.current) {
          draftInitializedRef.current = true;
          shouldFocusTitleRef.current = true;
          applyTaskToDraft(result.task, usersRef.current);
        } else {
          setLoadedTask(result.task);
        }
        setTaskGone(false);
        setLoadingDetail(false);
        return;
      }

      if (result.kind === 'not_found') {
        setTaskGone(true);
        setGeneralError(result.message);
        setLoadingDetail(false);
        return;
      }

      setLoadError(result.message);
      setLoadingDetail(false);
    },
    [applyTaskToDraft, taskId],
  );

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    return () => {
      if (dialog?.open) {
        dialog.close();
      }
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadDetail(controller.signal);
    return () => {
      controller.abort();
    };
  }, [loadDetail]);

  useEffect(() => {
    if (!loadingDetail && shouldFocusTitleRef.current && titleInputRef.current) {
      shouldFocusTitleRef.current = false;
      titleInputRef.current.focus();
    }
  }, [loadingDetail]);

  useEffect(() => {
    if (confirmingDelete) {
      cancelDeleteButtonRef.current?.focus();
    } else if (shouldFocusDeleteTriggerRef.current) {
      shouldFocusDeleteTriggerRef.current = false;
      deleteTriggerRef.current?.focus();
    }
  }, [confirmingDelete]);

  const closeDialog = () => {
    if (submittingRef.current) return;
    if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
    onClose();
  };

  const handleOpenDeleteConfirm = () => {
    if (submittingRef.current || loadingDetail || !loadedTask || taskGone) return;
    setDeleteError('');
    setUncertainDelete(false);
    setDeleteReconcileNotice('');
    setConfirmingDelete(true);
  };

  const handleCancelDeleteConfirm = () => {
    if (submittingRef.current) return;
    shouldFocusDeleteTriggerRef.current = true;
    setDeleteError('');
    setUncertainDelete(false);
    setDeleteReconcileNotice('');
    setConfirmingDelete(false);
  };

  const handleConfirmDelete = async () => {
    if (submittingRef.current || loadingDetail || !loadedTask || taskGone) return;
    submittingRef.current = true;
    setDeleting(true);
    setDeleteError('');
    setUncertainDelete(false);
    setDeleteReconcileNotice('');

    const result = await deleteTask(taskId);

    submittingRef.current = false;
    setDeleting(false);

    if (result.kind === 'deleted') {
      if (dialogRef.current?.open) {
        dialogRef.current.close();
      }
      onDeleted(taskId);
      return;
    }

    if (result.kind === 'not_found') {
      if (dialogRef.current?.open) {
        dialogRef.current.close();
      }
      onTaskAlreadyGone(taskId);
      return;
    }

    if (result.kind === 'rejected') {
      setDeleteError(result.message);
      return;
    }

    setUncertainDelete(true);
    setDeleteError(result.message);
  };

  const handleDeleteReconcile = async () => {
    if (deleteReconciling || submittingRef.current) return;
    setDeleteReconciling(true);
    setDeleteReconcileNotice('');
    const [detailResult, boardOk] = await Promise.all([fetchTask(taskId), onRefreshBoard()]);
    setDeleteReconciling(false);

    if (detailResult.kind === 'not_found') {
      if (dialogRef.current?.open) {
        dialogRef.current.close();
      }
      onTaskAlreadyGone(taskId);
      return;
    }

    if (detailResult.kind === 'ok') {
      onTaskLoadedRef.current(detailResult.task);
      setLoadedTask(detailResult.task);
      setDeleteReconcileNotice(
        'Task still exists on the server. You can retry deleting it or cancel.',
      );
      return;
    }

    setDeleteReconcileNotice(
      boardOk
        ? 'Board refreshed, but latest task details could not be verified.'
        : 'Latest task state could not be verified right now.',
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    wrapDialogFocus(event);
    if (event.key === 'Escape') {
      event.preventDefault();
      if (submittingRef.current) return;
      if (confirmingDelete) {
        handleCancelDeleteConfirm();
      } else {
        closeDialog();
      }
    }
  };

  const handleTitleChange = (nextTitle: string) => {
    setTitle(nextTitle);
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
    else if (errors.status) statusRef.current?.focus();
    else if (errors.priority) priorityRef.current?.focus();
    else if (errors.assigned_to) assigneeRef.current?.focus();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current || loadingDetail || !loadedTask || taskGone) return;

    const errors: Record<string, string> = {};
    if (codePointLength(title) > maxTitleCodePoints) {
      errors.title = 'Title must be 200 characters or fewer.';
    } else if (!title.trim()) {
      errors.title = 'Title is required.';
    }

    if (codePointLength(description) > maxDescriptionCodePoints) {
      errors.description = 'Description must be 2,000 characters or fewer.';
    }

    if (!['todo', 'in_progress', 'done'].includes(status)) {
      errors.status = 'Status must be todo, in_progress, or done.';
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
    setReconcileNotice('');
    setReconciledServerTask(null);

    const result = await updateTask(taskId, {
      title: title.trim(),
      description,
      status,
      priority,
      assigned_to: assigneeId,
    });

    submittingRef.current = false;
    setSubmitting(false);

    if (result.kind === 'updated') {
      if (dialogRef.current?.open) {
        dialogRef.current.close();
      }
      onSaved(result.task);
      return;
    }

    if (result.kind === 'not_found') {
      setTaskGone(true);
      setGeneralError(result.message);
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

  const handleReconcile = async () => {
    if (reconciling || submittingRef.current) return;
    setReconciling(true);
    setReconcileNotice('');
    const [detailResult, boardOk] = await Promise.all([fetchTask(taskId), onRefreshBoard()]);
    setReconciling(false);

    if (detailResult.kind === 'ok') {
      onTaskLoadedRef.current(detailResult.task);
      setLoadedTask(detailResult.task);
      setReconciledServerTask(detailResult.task);
      setReconcileNotice(
        'Latest task state checked. Your draft is preserved; reload the server version or save your changes again.',
      );
      return;
    }

    if (detailResult.kind === 'not_found') {
      setTaskGone(true);
      setUncertainSave(false);
      setGeneralError(detailResult.message);
      return;
    }

    setReconcileNotice(
      boardOk
        ? 'Board refreshed, but latest task details could not be verified.'
        : 'Latest task state could not be verified right now.',
    );
  };

  const handleRefreshAndClose = async () => {
    if (submittingRef.current) return;
    await onRefreshBoard();
    closeDialog();
  };

  const titleCount = codePointLength(title);
  const descriptionCount = codePointLength(description);
  const creatorName = loadedTask ? (people.get(loadedTask.created_by) ?? 'Unknown user') : '';

  return (
    <dialog
      ref={dialogRef}
      className="task-dialog"
      aria-labelledby="task-details-heading"
      aria-describedby={confirmingDelete ? 'delete-task-warning' : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (submittingRef.current) return;
        if (confirmingDelete) {
          handleCancelDeleteConfirm();
        } else {
          closeDialog();
        }
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="task-form">
        <div className="dialog-header">
          <h2 id="task-details-heading">Task Details</h2>
        </div>

        {loadingDetail && !loadedTask && (
          <>
            <p role="status">Loading task details…</p>
            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={closeDialog}>
                Cancel
              </button>
            </div>
          </>
        )}

        {!loadingDetail && loadError && !loadedTask && (
          <>
            <div className="dialog-alert" role="alert">
              <p>{loadError}</p>
            </div>
            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={closeDialog}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void loadDetail()}
              >
                Retry
              </button>
            </div>
          </>
        )}

        {!loadingDetail && taskGone && !loadedTask && (
          <>
            <div className="dialog-alert" role="alert">
              <p>{generalError || 'This task is no longer available on the board.'}</p>
            </div>
            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={closeDialog}>
                Close
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleRefreshAndClose()}
              >
                Refresh board
              </button>
            </div>
          </>
        )}

        {loadedTask && confirmingDelete && (
          <div className="delete-confirmation" role="group" aria-labelledby="delete-confirm-heading" aria-describedby="delete-task-warning">
            <div className="delete-warning-box">
              <h3 id="delete-confirm-heading">Confirm task deletion</h3>
              <p id="delete-task-warning">Permanently delete this task? This cannot be undone.</p>
              <p className="delete-target-title">
                Task: <strong>{loadedTask.title}</strong>
              </p>
            </div>

            {deleteError && (
              <div className="dialog-alert" role="alert">
                <p>{deleteError}</p>
                {uncertainDelete && (
                  <div className="uncertain-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void handleDeleteReconcile()}
                      disabled={deleteReconciling || deleting}
                    >
                      {deleteReconciling ? 'Checking task…' : 'Check latest task'}
                    </button>
                    {deleteReconcileNotice && <p className="board-check-notice">{deleteReconcileNotice}</p>}
                  </div>
                )}
              </div>
            )}

            <div className="dialog-actions">
              <button
                ref={cancelDeleteButtonRef}
                type="button"
                className="secondary-button"
                onClick={handleCancelDeleteConfirm}
                disabled={deleting || deleteReconciling}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void handleConfirmDelete()}
                disabled={deleting || deleteReconciling}
              >
                {deleting ? 'Deleting…' : 'Delete task'}
              </button>
            </div>
          </div>
        )}

        {loadedTask && !confirmingDelete && (
          <form className="task-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
            <div className="task-metadata" aria-label="Task metadata">
              <p>
                Created by: <strong>{creatorName}</strong>
              </p>
              <p>
                Created: <time dateTime={loadedTask.created_at}>{formatTimestamp(loadedTask.created_at)}</time>
              </p>
              <p>
                Last updated: <time dateTime={loadedTask.updated_at}>{formatTimestamp(loadedTask.updated_at)}</time>
              </p>
            </div>

            {generalError && (
              <div className="dialog-alert" role="alert">
                <p>{generalError}</p>
                {taskGone && (
                  <div className="uncertain-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void handleRefreshAndClose()}
                    >
                      Refresh board
                    </button>
                  </div>
                )}
                {uncertainSave && !taskGone && (
                  <div className="uncertain-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void handleReconcile()}
                      disabled={reconciling || submitting}
                    >
                      {reconciling ? 'Checking task…' : 'Check latest task'}
                    </button>
                    {reconciledServerTask && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => applyTaskToDraft(reconciledServerTask, users)}
                        disabled={submitting}
                      >
                        Reload latest task
                      </button>
                    )}
                    {reconcileNotice && <p className="board-check-notice">{reconcileNotice}</p>}
                  </div>
                )}
              </div>
            )}

            <div className="form-field">
              <div className="field-label-row">
                <label htmlFor="detail-task-title">Title</label>
                <span className="char-counter" aria-hidden="true">
                  {titleCount}/{maxTitleCodePoints}
                </span>
              </div>
              <input
                ref={titleInputRef}
                id="detail-task-title"
                name="title"
                type="text"
                required
                value={title}
                disabled={submitting}
                aria-invalid={Boolean(fieldErrors.title)}
                aria-describedby={fieldErrors.title ? 'detail-task-title-error' : undefined}
                onChange={(event) => handleTitleChange(event.target.value)}
              />
              {fieldErrors.title && (
                <p id="detail-task-title-error" className="field-error" aria-live="polite">
                  {fieldErrors.title}
                </p>
              )}
            </div>

            <div className="form-field">
              <div className="field-label-row">
                <label htmlFor="detail-task-description">Description</label>
                <span className="char-counter" aria-hidden="true">
                  {descriptionCount}/{maxDescriptionCodePoints}
                </span>
              </div>
              <textarea
                ref={descriptionRef}
                id="detail-task-description"
                name="description"
                rows={4}
                value={description}
                disabled={submitting}
                aria-invalid={Boolean(fieldErrors.description)}
                aria-describedby={fieldErrors.description ? 'detail-task-description-error' : undefined}
                onChange={(event) => handleDescriptionChange(event.target.value)}
              />
              {fieldErrors.description && (
                <p id="detail-task-description-error" className="field-error" aria-live="polite">
                  {fieldErrors.description}
                </p>
              )}
            </div>

            <div className="form-row">
              <div className="form-field">
                <label htmlFor="detail-task-status">Status</label>
                <select
                  ref={statusRef}
                  id="detail-task-status"
                  name="status"
                  value={status}
                  disabled={submitting}
                  aria-invalid={Boolean(fieldErrors.status)}
                  aria-describedby={fieldErrors.status ? 'detail-task-status-error' : undefined}
                  onChange={(event) => setStatus(event.target.value as TaskStatus)}
                >
                  <option value="todo">To do</option>
                  <option value="in_progress">In progress</option>
                  <option value="done">Done</option>
                </select>
                {fieldErrors.status && (
                  <p id="detail-task-status-error" className="field-error" aria-live="polite">
                    {fieldErrors.status}
                  </p>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="detail-task-priority">Priority</label>
                <select
                  ref={priorityRef}
                  id="detail-task-priority"
                  name="priority"
                  value={priority}
                  disabled={submitting}
                  aria-invalid={Boolean(fieldErrors.priority)}
                  aria-describedby={fieldErrors.priority ? 'detail-task-priority-error' : undefined}
                  onChange={(event) => setPriority(event.target.value as TaskPriority)}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
                {fieldErrors.priority && (
                  <p id="detail-task-priority-error" className="field-error" aria-live="polite">
                    {fieldErrors.priority}
                  </p>
                )}
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="detail-task-assignee">Assignee</label>
              <select
                ref={assigneeRef}
                id="detail-task-assignee"
                name="assigned_to"
                value={assignedTo}
                disabled={submitting}
                aria-invalid={Boolean(fieldErrors.assigned_to)}
                aria-describedby={fieldErrors.assigned_to ? 'detail-task-assignee-error' : undefined}
                onChange={(event) => {
                  setAssignedTo(event.target.value);
                  setFieldErrors((prev) => {
                    if (!prev.assigned_to) return prev;
                    const next = { ...prev };
                    delete next.assigned_to;
                    return next;
                  });
                }}
              >
                {assignedTo === '' && <option value="">Unknown user (select assignee)</option>}
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
              {fieldErrors.assigned_to && (
                <p id="detail-task-assignee-error" className="field-error" aria-live="polite">
                  {fieldErrors.assigned_to}
                </p>
              )}
            </div>

            <div className="dialog-actions">
              <button
                ref={deleteTriggerRef}
                type="button"
                className="delete-task-trigger"
                onClick={handleOpenDeleteConfirm}
                disabled={submitting || taskGone}
              >
                Delete task
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={closeDialog}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={submitting || taskGone}
              >
                {submitting ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
