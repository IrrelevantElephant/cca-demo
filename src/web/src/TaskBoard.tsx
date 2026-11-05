import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CreateTaskDialog from './CreateTaskDialog';
import TaskDetailsDialog from './TaskDetailsDialog';
import { fetchTask, fetchTasks, updateTask } from './taskApi';
import { useCurrentUser } from './types';
import type { Task, TaskPriority, TaskStatus, User } from './types';

const statuses: TaskStatus[] = ['todo', 'in_progress', 'done'];
const labels: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done' };

type QuickStatusError = {
  requestedStatus: TaskStatus;
  message: string;
  uncertain: boolean;
  reconcileNotice?: string;
};

type TaskCardProps = {
  task: Task;
  assignee: string;
  quickPending: boolean;
  editingOpen: boolean;
  quickError?: QuickStatusError;
  onOpenDetails: (taskId: number) => void;
  onQuickStatusChange: (task: Task, nextStatus: TaskStatus) => void;
  onQuickReconcile: (taskId: number) => void;
};

function TaskCard({
  task,
  assignee,
  quickPending,
  editingOpen,
  quickError,
  onOpenDetails,
  onQuickStatusChange,
  onQuickReconcile,
}: TaskCardProps) {
  const statusSelectId = `quick-status-${task.id}`;
  return (
    <li className="task-card" data-task-id={task.id}>
      <div
        className="task-card-body"
        onClick={() => {
          if (!quickPending) onOpenDetails(task.id);
        }}
      >
        <h3>
          <button
            type="button"
            className="task-card-trigger"
            disabled={quickPending}
            onClick={(event) => {
              event.stopPropagation();
              if (!quickPending) onOpenDetails(task.id);
            }}
          >
            {task.title}
          </button>
        </h3>
        <p className={`priority priority-${task.priority}`}>Priority: {task.priority}</p>
        {task.description && <p className="task-description">{task.description}</p>}
        <p>Assigned to: {assignee}</p>
      </div>
      <div
        className="task-card-status"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="quick-status-row">
          <label htmlFor={statusSelectId}>Status</label>
          <select
            id={statusSelectId}
            className="quick-status-select"
            value={task.status}
            disabled={quickPending || editingOpen}
            onChange={(event) => {
              const nextStatus = event.target.value as TaskStatus;
              if (nextStatus !== task.status) {
                onQuickStatusChange(task, nextStatus);
              }
            }}
          >
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
          </select>
        </div>
        {quickPending && (
          <p className="quick-status-pending" aria-live="polite">
            Updating status…
          </p>
        )}
        {quickError && !quickPending && (
          <div className="quick-status-error" role="alert">
            <p>{quickError.message}</p>
            {quickError.reconcileNotice && (
              <p className="quick-status-reconcile-notice">{quickError.reconcileNotice}</p>
            )}
            <div className="quick-status-error-actions">
              {quickError.uncertain && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onQuickReconcile(task.id)}
                >
                  Check latest task
                </button>
              )}
              <button
                type="button"
                className="inline-retry"
                onClick={() => onQuickStatusChange(task, quickError.requestedStatus)}
              >
                Retry status update
              </button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

type TaskColumnProps = {
  status: TaskStatus;
  tasks: Task[];
  isFiltered: boolean;
  people: Map<number, string>;
  pendingQuickIds: Set<number>;
  editingTaskId: number | null;
  quickErrors: Record<number, QuickStatusError>;
  onOpenDetails: (taskId: number) => void;
  onQuickStatusChange: (task: Task, nextStatus: TaskStatus) => void;
  onQuickReconcile: (taskId: number) => void;
};

function TaskColumn({
  status,
  tasks,
  isFiltered,
  people,
  pendingQuickIds,
  editingTaskId,
  quickErrors,
  onOpenDetails,
  onQuickStatusChange,
  onQuickReconcile,
}: TaskColumnProps) {
  return (
    <section className="column" aria-labelledby={`heading-${status}`}>
      <h2 id={`heading-${status}`}>
        {labels[status]} <span>({tasks.length})</span>
      </h2>
      {tasks.length ? (
        <ul>
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              assignee={people.get(task.assigned_to) ?? 'Unknown user'}
              quickPending={pendingQuickIds.has(task.id)}
              editingOpen={editingTaskId === task.id}
              quickError={quickErrors[task.id]}
              onOpenDetails={onOpenDetails}
              onQuickStatusChange={onQuickStatusChange}
              onQuickReconcile={onQuickReconcile}
            />
          ))}
        </ul>
      ) : (
        <p className="empty-column-message">{isFiltered ? 'No matching tasks in this column.' : 'No tasks in this column.'}</p>
      )}
    </section>
  );
}

type FocusRestoreTarget =
  | { kind: 'card-trigger'; taskId: number }
  | { kind: 'quick-status'; taskId: number }
  | { kind: 'board-control' };

function selectPostDeleteFocusTarget(tasks: Task[] | undefined, deletedTaskId: number): FocusRestoreTarget {
  if (!tasks || tasks.length === 0) {
    return { kind: 'board-control' };
  }
  const deletedTask = tasks.find((task) => task.id === deletedTaskId);
  if (deletedTask) {
    const columnTasks = tasks.filter((task) => task.status === deletedTask.status);
    const index = columnTasks.findIndex((task) => task.id === deletedTaskId);
    if (index >= 0 && index + 1 < columnTasks.length) {
      return { kind: 'card-trigger', taskId: columnTasks[index + 1].id };
    }
    if (index > 0) {
      return { kind: 'card-trigger', taskId: columnTasks[index - 1].id };
    }
  }
  const remaining = tasks.find((task) => task.id !== deletedTaskId);
  if (remaining) {
    return { kind: 'card-trigger', taskId: remaining.id };
  }
  return { kind: 'board-control' };
}

export default function TaskBoard({ users }: { users: User[] }) {
  const { selectedUser } = useCurrentUser();
  const [snapshot, setSnapshot] = useState<{ tasks: Task[]; rejected: number } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [postCreateRefreshFailed, setPostCreateRefreshFailed] = useState(false);
  const [postDeleteRefreshFailed, setPostDeleteRefreshFailed] = useState(false);
  const [scrollTargetId, setScrollTargetId] = useState<number | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusRestoreTarget | null>(null);
  const [dialogState, setDialogState] = useState<{ open: boolean; session: number; creator: User | null }>({
    open: false,
    session: 0,
    creator: null,
  });
  const [detailsDialogState, setDetailsDialogState] = useState<{
    open: boolean;
    session: number;
    taskId: number | null;
  }>({
    open: false,
    session: 0,
    taskId: null,
  });
  const [pendingQuickList, setPendingQuickList] = useState<number[]>([]);
  const [quickErrors, setQuickErrors] = useState<Record<number, QuickStatusError>>({});
  const [assigneeFilter, setAssigneeFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>('');
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | ''>('');

  const pending = useRef<AbortController | null>(null);
  const loadGenerationRef = useRef(0);
  const pendingQuickIdsRef = useRef<Set<number>>(new Set());
  const createButtonRef = useRef<HTMLButtonElement | null>(null);
  const refreshButtonRef = useRef<HTMLButtonElement | null>(null);
  const people = useMemo(() => new Map(users.map((user) => [user.id, user.name])), [users]);
  const pendingQuickIds = useMemo(() => new Set(pendingQuickList), [pendingQuickList]);
  const canCreate = Boolean(selectedUser && users.some((user) => user.id === selectedUser.id));
  const hasActiveFilters = Boolean(assigneeFilter || statusFilter || priorityFilter);
  const selectedAssigneeId = assigneeFilter === '' ? null : Number(assigneeFilter);

  const summary = useMemo(() => {
    const tasks = snapshot?.tasks ?? [];
    return {
      total: tasks.length,
      todo: tasks.filter(task => task.status === 'todo').length,
      inProgress: tasks.filter(task => task.status === 'in_progress').length,
      completed: tasks.filter(task => task.status === 'done').length,
    };
  }, [snapshot]);

  const filteredTasks = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.tasks.filter((task) => {
      const matchesAssignee =
        selectedAssigneeId === null || task.assigned_to === selectedAssigneeId;
      const matchesStatus =
        !statusFilter || task.status === statusFilter;
      const matchesPriority =
        !priorityFilter || task.priority === priorityFilter;
      return matchesAssignee && matchesStatus && matchesPriority;
    });
  }, [snapshot, selectedAssigneeId, statusFilter, priorityFilter]);

  const handleClearFilters = useCallback(() => {
    setAssigneeFilter('');
    setStatusFilter('');
    setPriorityFilter('');
  }, []);

  const invalidateInFlightLoad = useCallback(() => {
    loadGenerationRef.current += 1;
    if (pending.current) {
      pending.current.abort();
      pending.current = null;
      setBusy(false);
    }
  }, []);

  const replaceTaskById = useCallback((updatedTask: Task) => {
    setSnapshot((prev) => {
      if (!prev) return prev;
      if (!prev.tasks.some((task) => task.id === updatedTask.id)) return prev;
      return {
        ...prev,
        tasks: prev.tasks.map((task) => (task.id === updatedTask.id ? updatedTask : task)),
      };
    });
  }, []);

  const removeTaskById = useCallback((taskId: number) => {
    setSnapshot((prev) => {
      if (!prev) return prev;
      if (!prev.tasks.some((task) => task.id === taskId)) return prev;
      return {
        ...prev,
        tasks: prev.tasks.filter((task) => task.id !== taskId),
      };
    });
  }, []);

  const load = useCallback(
    async (options?: { force?: boolean }): Promise<{ ok: boolean; tasks?: Task[]; aborted?: boolean }> => {
      const force = options?.force ?? false;
      if (pending.current) {
        if (!force) return { ok: false, aborted: true };
        pending.current.abort();
        pending.current = null;
      }
      const generation = loadGenerationRef.current + 1;
      loadGenerationRef.current = generation;
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError('');
      try {
        const result = await fetchTasks(controller.signal);
        if (!controller.signal.aborted && pending.current === controller && loadGenerationRef.current === generation) {
          setSnapshot(result);
          setPostCreateRefreshFailed(false);
          setPostDeleteRefreshFailed(false);
          return { ok: true, tasks: result.tasks };
        }
        return { ok: false, aborted: true };
      } catch (cause) {
        if (!controller.signal.aborted && pending.current === controller && loadGenerationRef.current === generation) {
          setError(
            cause instanceof Error && cause.message.startsWith('Invalid task data:')
              ? cause.message
              : 'Task request failed.',
          );
          return { ok: false };
        }
        return { ok: false, aborted: true };
      } finally {
        if (pending.current === controller) {
          pending.current = null;
          setBusy(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void load();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [load]);

  useEffect(() => {
    if (scrollTargetId === null || !snapshot) return;
    const card = document.querySelector<HTMLElement>(`.task-card[data-task-id="${scrollTargetId}"]`);
    card?.scrollIntoView?.({ block: 'nearest' });
    setScrollTargetId(null);
  }, [snapshot, scrollTargetId]);

  useEffect(() => {
    if (!focusTarget || detailsDialogState.open) return;
    if (focusTarget.kind === 'quick-status') {
      const select = document.querySelector<HTMLSelectElement>(
        `.task-card[data-task-id="${focusTarget.taskId}"] .quick-status-select`,
      );
      if (select) {
        select.scrollIntoView?.({ block: 'nearest' });
        select.focus();
      } else {
        (createButtonRef.current && !createButtonRef.current.disabled
          ? createButtonRef.current
          : refreshButtonRef.current
        )?.focus();
      }
    } else if (focusTarget.kind === 'card-trigger') {
      const trigger = document.querySelector<HTMLButtonElement>(
        `.task-card[data-task-id="${focusTarget.taskId}"] .task-card-trigger`,
      );
      if (trigger) {
        trigger.scrollIntoView?.({ block: 'nearest' });
        trigger.focus();
      } else {
        (createButtonRef.current && !createButtonRef.current.disabled
          ? createButtonRef.current
          : refreshButtonRef.current
        )?.focus();
      }
    } else {
      (createButtonRef.current && !createButtonRef.current.disabled
        ? createButtonRef.current
        : refreshButtonRef.current
      )?.focus();
    }
    setFocusTarget(null);
  }, [detailsDialogState.open, focusTarget, snapshot]);

  const handleOpenCreate = () => {
    if (!selectedUser || !canCreate) return;
    setNotice('');
    setDialogState((prev) => ({
      open: true,
      session: prev.session + 1,
      creator: selectedUser,
    }));
  };

  const handleCloseCreate = () => {
    setDialogState((prev) => ({ ...prev, open: false }));
    createButtonRef.current?.focus();
  };

  const handleTaskCreated = (createdTask: Task) => {
    setDialogState((prev) => ({ ...prev, open: false }));
    setSnapshot(prev => prev ? {
      ...prev,
      tasks: prev.tasks.some(task => task.id === createdTask.id)
        ? prev.tasks : [...prev.tasks, createdTask],
    } : { tasks: [createdTask], rejected: 0 });
    setNotice('Task created successfully.');
    createButtonRef.current?.focus();
    void (async () => {
      const outcome = await load({ force: true });
      if (outcome.aborted) return;
      if (!outcome.ok || !outcome.tasks?.some((task) => task.id === createdTask.id)) {
        setPostCreateRefreshFailed(true);
        setNotice('');
        setError((prev) => prev || 'Created task could not be verified on the refreshed board.');
        return;
      }
      setPostCreateRefreshFailed(false);
      setScrollTargetId(createdTask.id);
    })();
  };

  const handleCheckBoard = useCallback(async () => {
    const outcome = await load({ force: true });
    return outcome.ok;
  }, [load]);

  const handleOpenDetails = useCallback((taskId: number) => {
    if (pendingQuickIdsRef.current.has(taskId)) return;
    setNotice('');
    setDetailsDialogState((prev) => ({
      open: true,
      session: prev.session + 1,
      taskId,
    }));
  }, []);

  const handleCloseDetails = useCallback(() => {
    setDetailsDialogState((prev) => {
      if (prev.taskId !== null) {
        setFocusTarget({ kind: 'card-trigger', taskId: prev.taskId });
      }
      return { ...prev, open: false };
    });
  }, []);

  const handleTaskSaved = useCallback(
    (updatedTask: Task) => {
      invalidateInFlightLoad();
      replaceTaskById(updatedTask);
      setQuickErrors((prev) => {
        if (!prev[updatedTask.id]) return prev;
        const next = { ...prev };
        delete next[updatedTask.id];
        return next;
      });
      setNotice('Task updated successfully.');
      setDetailsDialogState((prev) => ({ ...prev, open: false }));
      setFocusTarget({ kind: 'card-trigger', taskId: updatedTask.id });
    },
    [invalidateInFlightLoad, replaceTaskById],
  );

  const handleTaskDeleted = useCallback(
    (deletedTaskId: number) => {
      invalidateInFlightLoad();
      setFocusTarget(selectPostDeleteFocusTarget(filteredTasks, deletedTaskId));
      removeTaskById(deletedTaskId);
      setQuickErrors((prev) => {
        if (!prev[deletedTaskId]) return prev;
        const next = { ...prev };
        delete next[deletedTaskId];
        return next;
      });
      setNotice('Task deleted.');
      setDetailsDialogState((prev) => ({ ...prev, open: false }));
      void (async () => {
        const outcome = await load({ force: true });
        if (outcome.aborted) return;
        if (!outcome.ok) {
          setPostDeleteRefreshFailed(true);
          setNotice('');
          setError((prev) => prev || 'Task request failed.');
          return;
        }
        setPostDeleteRefreshFailed(false);
      })();
    },
    [filteredTasks, invalidateInFlightLoad, load, removeTaskById],
  );

  const handleTaskAlreadyGone = useCallback(
    (missingTaskId: number) => {
      invalidateInFlightLoad();
      setFocusTarget(selectPostDeleteFocusTarget(filteredTasks, missingTaskId));
      removeTaskById(missingTaskId);
      setQuickErrors((prev) => {
        if (!prev[missingTaskId]) return prev;
        const next = { ...prev };
        delete next[missingTaskId];
        return next;
      });
      setNotice('Task no longer exists on the server; board updated.');
      setDetailsDialogState((prev) => ({ ...prev, open: false }));
      void load({ force: true });
    },
    [filteredTasks, invalidateInFlightLoad, load, removeTaskById],
  );

  const handleQuickStatusChange = useCallback(
    async (task: Task, requestedStatus: TaskStatus) => {
      if (pendingQuickIdsRef.current.has(task.id)) return;
      if (detailsDialogState.open && detailsDialogState.taskId === task.id) return;

      invalidateInFlightLoad();
      pendingQuickIdsRef.current.add(task.id);
      setPendingQuickList(Array.from(pendingQuickIdsRef.current));
      setNotice('');
      setQuickErrors((prev) => {
        if (!prev[task.id]) return prev;
        const next = { ...prev };
        delete next[task.id];
        return next;
      });

      const result = await updateTask(task.id, {
        title: task.title,
        description: task.description ?? '',
        status: requestedStatus,
        priority: task.priority,
        assigned_to: task.assigned_to,
      });

      pendingQuickIdsRef.current.delete(task.id);
      setPendingQuickList(Array.from(pendingQuickIdsRef.current));

      if (result.kind === 'updated') {
        invalidateInFlightLoad();
        replaceTaskById(result.task);
        setNotice('Task status updated.');
        setFocusTarget({ kind: 'quick-status', taskId: result.task.id });
        return;
      }

      if (result.kind === 'uncertain') {
        setQuickErrors((prev) => ({
          ...prev,
          [task.id]: {
            requestedStatus,
            message: result.message,
            uncertain: true,
          },
        }));
        return;
      }

      setQuickErrors((prev) => ({
        ...prev,
        [task.id]: {
          requestedStatus,
          message: result.message,
          uncertain: false,
        },
      }));
    },
    [detailsDialogState.open, detailsDialogState.taskId, invalidateInFlightLoad, replaceTaskById],
  );

  const handleQuickReconcile = useCallback(
    async (taskId: number) => {
      if (pendingQuickIdsRef.current.has(taskId)) return;
      const result = await fetchTask(taskId);
      if (result.kind === 'ok') {
        invalidateInFlightLoad();
        replaceTaskById(result.task);
        setQuickErrors((prev) => {
          const current = prev[taskId];
          if (!current) return prev;
          if (result.task.status === current.requestedStatus) {
            const next = { ...prev };
            delete next[taskId];
            return next;
          }
          return {
            ...prev,
            [taskId]: {
              ...current,
              reconcileNotice: `Latest server status is ${labels[result.task.status]}. Retry if you still want to move this task.`,
            },
          };
        });
        return;
      }
      if (result.kind === 'not_found') {
        await load({ force: true });
        return;
      }
      setQuickErrors((prev) => {
        const current = prev[taskId];
        if (!current) return prev;
        return {
          ...prev,
          [taskId]: {
            ...current,
            reconcileNotice: result.message,
          },
        };
      });
    },
    [invalidateInFlightLoad, load, replaceTaskById],
  );

  return (
    <section className="board" aria-label="Task board">
      {snapshot && (
        <section className="dashboard-summary" aria-label="Dashboard summary">
          <div className="summary-grid">
            {([
              ['total', 'Total Tasks', summary.total, 'All board tasks', 'total'],
              ['todo', 'To Do', summary.todo, 'Awaiting work', 'todo'],
              ['in_progress', 'In Progress', summary.inProgress, 'Currently active', 'in-progress'],
              ['done', 'Completed', summary.completed, 'Finished work', 'completed'],
            ] as const).map(([key, label, value, subtext, testId]) => (
              <div key={key} className={`summary-card summary-card-${key}`} data-summary-card={key}>
                <span className="summary-label">{label}</span>
                <strong className="summary-value" data-testid={`summary-${testId}`}>{value}</strong>
                <span className="summary-subtext">{subtext}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="board-toolbar">
      <div className="board-tools">
        {notice ? (
          <span role="status">{notice}</span>
        ) : busy ? (
          <span role="status">{snapshot ? 'Refreshing tasks…' : 'Loading tasks…'}</span>
        ) : null}
        <button
          ref={createButtonRef}
          type="button"
          className="create-task-button"
          onClick={handleOpenCreate}
          disabled={!canCreate}
        >
          Create Task
        </button>
        <button
          ref={refreshButtonRef}
          type="button"
          onClick={() => {
            setNotice('');
            void load({ force: postCreateRefreshFailed || postDeleteRefreshFailed });
          }}
          disabled={busy || pendingQuickList.length > 0}
        >
          {snapshot ? 'Refresh' : 'Retry'}
        </button>
      </div>
      <div className="board-filters" role="group" aria-label="Task filters">
        <div className="filter-field">
          <label htmlFor="filter-assignee">Assignee</label>
          <select
            id="filter-assignee"
            value={assigneeFilter}
            onChange={(event) => setAssigneeFilter(event.target.value)}
          >
            <option value="">All Users</option>
            {users.map((user) => (
              <option key={user.id} value={String(user.id)}>
                {user.name}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="filter-status">Status</label>
          <select
            id="filter-status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as TaskStatus | '')}
          >
            <option value="">All Statuses</option>
            <option value="todo">To Do</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Done</option>
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="filter-priority">Priority</label>
          <select
            id="filter-priority"
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value as TaskPriority | '')}
          >
            <option value="">All Priorities</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <button
          type="button"
          className="secondary-button clear-filters-button"
          onClick={handleClearFilters}
          disabled={!hasActiveFilters}
        >
          Clear Filters
        </button>
        {hasActiveFilters && snapshot && (
          <p className="filter-scope-note">Showing {filteredTasks.length} of {summary.total} tasks on board (summary shows all tasks)</p>
        )}
      </div>
      </div>
      {error && (
        <p className="board-alert" role="alert">
          {postCreateRefreshFailed
            ? `Task saved, but the board could not be refreshed. ${error}`
            : postDeleteRefreshFailed
              ? `Task deleted, but the board could not be refreshed. ${error}`
              : `${snapshot ? 'Tasks could not be refreshed; showing stale data.' : 'Tasks could not be loaded.'} ${error} ${snapshot ? 'Use Refresh to retry.' : 'Retry.'}`}
          {(postCreateRefreshFailed || postDeleteRefreshFailed) && (
            <>
              {' '}
              <button
                type="button"
                className="inline-retry"
                onClick={() => void load({ force: true })}
                disabled={busy}
              >
                Retry refresh
              </button>
            </>
          )}
        </p>
      )}
      {!!snapshot?.rejected && <p role="status">{snapshot.rejected} invalid task record(s) omitted.</p>}
      {snapshot && (
        <>
          {!hasActiveFilters && snapshot.tasks.length === 0 && (
            <div className="empty-board">
              <p className="empty-board-title">No tasks yet</p>
              <p className="empty-board-subtitle">Create your first task to get started.</p>
            </div>
          )}
          {hasActiveFilters && filteredTasks.length === 0 && (
            <p className="empty-filter-results">No tasks match the selected filters.</p>
          )}
          <div className="columns">
            {statuses.map((status) => (
              <TaskColumn
                key={status}
                status={status}
                tasks={filteredTasks.filter((task) => task.status === status)}
                isFiltered={hasActiveFilters}
                people={people}
                pendingQuickIds={pendingQuickIds}
                editingTaskId={detailsDialogState.open ? detailsDialogState.taskId : null}
                quickErrors={quickErrors}
                onOpenDetails={handleOpenDetails}
                onQuickStatusChange={(task, nextStatus) => void handleQuickStatusChange(task, nextStatus)}
                onQuickReconcile={(taskId) => void handleQuickReconcile(taskId)}
              />
            ))}
          </div>
        </>
      )}
      {dialogState.open && dialogState.creator && (
        <CreateTaskDialog
          key={dialogState.session}
          creator={dialogState.creator}
          users={users}
          onClose={handleCloseCreate}
          onCreated={handleTaskCreated}
          onCheckBoard={handleCheckBoard}
        />
      )}
      {detailsDialogState.open && detailsDialogState.taskId !== null && (
        <TaskDetailsDialog
          key={detailsDialogState.session}
          taskId={detailsDialogState.taskId}
          users={users}
          onClose={handleCloseDetails}
          onSaved={handleTaskSaved}
          onDeleted={handleTaskDeleted}
          onTaskAlreadyGone={handleTaskAlreadyGone}
          onTaskLoaded={replaceTaskById}
          onRefreshBoard={handleCheckBoard}
        />
      )}
    </section>
  );
}
