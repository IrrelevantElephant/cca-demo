import type { CreateTaskPayload, Task, TaskUpdateInput } from './types';

export const maxTitleCodePoints = 200;
export const maxDescriptionCodePoints = 2000;

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

const postgresID = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
const timestamp = (value: unknown) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

function invalidReason(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'not an object';
  const task = value as Record<string, unknown>;
  if (!postgresID(task.id)) return 'invalid id';
  if (typeof task.title !== 'string' || !task.title.trim()) return 'invalid title';
  if (task.description !== null && typeof task.description !== 'string') return 'invalid description';
  if (typeof task.status !== 'string' || !['todo', 'in_progress', 'done'].includes(task.status)) return 'invalid status';
  if (typeof task.priority !== 'string' || !['low', 'medium', 'high'].includes(task.priority)) return 'invalid priority';
  if (!postgresID(task.assigned_to) || !postgresID(task.created_by)) return 'invalid user id';
  if (!timestamp(task.created_at) || !timestamp(task.updated_at)) return 'invalid timestamp';
  return null;
}

export async function fetchTasks(signal: AbortSignal): Promise<{ tasks: Task[]; rejected: number }> {
  const response = await fetch('/api/tasks', { signal });
  if (!response.ok) throw new Error('Task request failed');
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error('Invalid task data: expected an array.');
  const tasks: Task[] = [];
  const ids = new Set<number>();
  for (const value of payload) {
    const task = value as Task;
    const reason = invalidReason(value) ?? (ids.has(task.id) ? 'duplicate id' : null);
    if (reason) {
      // Do not include titles/descriptions or arbitrary malformed values in diagnostics.
      console.warn('Task record omitted:', reason, typeof task?.id === 'number' ? task.id : '(unknown id)');
    } else {
      ids.add(task.id);
      tasks.push(task);
    }
  }
  if (payload.length && !tasks.length) throw new Error('Invalid task data: no usable records.');
  return { tasks, rejected: payload.length - tasks.length };
}

export type FetchTaskResult =
  | { kind: 'ok'; task: Task }
  | { kind: 'not_found'; message: string }
  | { kind: 'error'; message: string };

async function parseErrorResponse(
  response: Response,
  fallbackMessage: string,
): Promise<{ message: string; fields: Record<string, string> }> {
  let message = fallbackMessage;
  const fields: Record<string, string> = {};
  try {
    const errBody: unknown = await response.json();
    if (errBody && typeof errBody === 'object') {
      const record = errBody as Record<string, unknown>;
      if (typeof record.message === 'string' && record.message.trim()) {
        message = record.message;
      }
      if (record.fields && typeof record.fields === 'object') {
        for (const [key, value] of Object.entries(record.fields as Record<string, unknown>)) {
          if (typeof value === 'string' && value.trim()) {
            fields[key] = value;
          }
        }
      }
    }
  } catch {
    // Use fallback message when error response is not JSON.
  }
  return { message, fields };
}

export async function fetchTask(id: number, signal?: AbortSignal): Promise<FetchTaskResult> {
  if (!postgresID(id)) {
    return { kind: 'error', message: 'Invalid task ID.' };
  }
  let response: Response;
  try {
    response = await fetch(`/api/tasks/${id}`, { signal });
  } catch {
    return { kind: 'error', message: 'Task details could not be loaded. Check your connection and try again.' };
  }

  if (response.status === 404) {
    return { kind: 'not_found', message: 'This task is no longer available on the board.' };
  }

  if (!response.ok) {
    const { message } = await parseErrorResponse(
      response,
      'Task details could not be loaded. Please try again.',
    );
    return { kind: 'error', message };
  }

  try {
    const data: unknown = await response.json();
    const task = data as Task;
    if (invalidReason(data) !== null || task.id !== id) {
      return { kind: 'error', message: 'Invalid task data: task response could not be verified.' };
    }
    return { kind: 'ok', task };
  } catch {
    return { kind: 'error', message: 'Invalid task data: task response could not be read.' };
  }
}

export type CreateTaskResult =
  | { kind: 'created'; task: Task }
  | { kind: 'rejected'; status: number; message: string; fields: Record<string, string> }
  | { kind: 'uncertain'; message: string };

export async function createTask(payload: CreateTaskPayload): Promise<CreateTaskResult> {
  let response: Response;
  try {
    response = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      kind: 'uncertain',
      message: 'We could not confirm whether your task was saved. Check the board before submitting again to avoid duplicates.',
    };
  }

  if (!response.ok) {
    const { message, fields } = await parseErrorResponse(
      response,
      'Task could not be created. Please review the form and try again.',
    );
    return { kind: 'rejected', status: response.status, message, fields };
  }

  try {
    const data: unknown = await response.json();
    if (invalidReason(data) !== null) {
      return {
        kind: 'uncertain',
        message: 'The task may have been saved, but the server response could not be verified. Check the board before submitting again.',
      };
    }
    return { kind: 'created', task: data as Task };
  } catch {
    return {
      kind: 'uncertain',
      message: 'The task may have been saved, but the server response could not be read. Check the board before submitting again.',
    };
  }
}

export type UpdateTaskResult =
  | { kind: 'updated'; task: Task }
  | { kind: 'not_found'; message: string }
  | { kind: 'rejected'; status: number; message: string; fields: Record<string, string> }
  | { kind: 'uncertain'; message: string };

export async function updateTask(id: number, input: TaskUpdateInput): Promise<UpdateTaskResult> {
  const editablePayload: TaskUpdateInput = {
    title: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    status: input.status,
    priority: input.priority,
    assigned_to: input.assigned_to,
  };

  let response: Response;
  try {
    response = await fetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editablePayload),
    });
  } catch {
    return {
      kind: 'uncertain',
      message: 'We could not confirm whether your changes were saved. Check the latest task state before saving again.',
    };
  }

  if (response.status === 404) {
    return {
      kind: 'not_found',
      message: 'This task is no longer available on the server. Your draft is preserved below; close or refresh the board when ready.',
    };
  }

  if (!response.ok) {
    const { message, fields } = await parseErrorResponse(
      response,
      'Changes could not be saved. Please review the task and try again.',
    );
    return { kind: 'rejected', status: response.status, message, fields };
  }

  try {
    const data: unknown = await response.json();
    const task = data as Task;
    if (invalidReason(data) !== null || task.id !== id) {
      return {
        kind: 'uncertain',
        message: 'Your changes may have been saved, but the server response could not be verified. Check the latest task state before saving again.',
      };
    }
    return { kind: 'updated', task };
  } catch {
    return {
      kind: 'uncertain',
      message: 'Your changes may have been saved, but the server response could not be read. Check the latest task state before saving again.',
    };
  }
}

export type DeleteTaskResult =
  | { kind: 'deleted' }
  | { kind: 'not_found'; message: string }
  | { kind: 'rejected'; status: number; message: string }
  | { kind: 'uncertain'; message: string };

export async function deleteTask(id: number): Promise<DeleteTaskResult> {
  if (!postgresID(id)) {
    return { kind: 'rejected', status: 400, message: 'Invalid task ID.' };
  }

  let response: Response;
  try {
    response = await fetch(`/api/tasks/${id}`, {
      method: 'DELETE',
    });
  } catch {
    return {
      kind: 'uncertain',
      message: 'We could not confirm whether the task was deleted. Check the latest task state before trying again.',
    };
  }

  if (response.status === 204) {
    return { kind: 'deleted' };
  }

  if (response.status === 404) {
    return {
      kind: 'not_found',
      message: 'This task no longer exists on the server.',
    };
  }

  if (!response.ok) {
    const { message } = await parseErrorResponse(
      response,
      'Task could not be deleted. Please try again.',
    );
    return { kind: 'rejected', status: response.status, message };
  }

  return {
    kind: 'uncertain',
    message: 'The task may have been deleted, but the server response could not be verified. Check the latest task state before trying again.',
  };
}
