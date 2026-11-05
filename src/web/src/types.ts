import { createContext, useContext } from 'react';

export type User = { id: number; name: string; role: string };
export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';
export type Task = { id: number; title: string; description: string | null; status: TaskStatus; priority: TaskPriority; assigned_to: number; created_by: number; created_at: string; updated_at: string };
export type CreateTaskPayload = {
  title: string;
  description?: string;
  priority: TaskPriority;
  assigned_to: number;
  created_by: number;
};
export type TaskUpdateInput = {
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_to: number;
};
type UserContextValue = { users: User[]; selectedUser: User | null; setSelectedUser: (user: User) => void };
export const UserContext = createContext<UserContextValue | null>(null);

export function useCurrentUser() {
  const context = useContext(UserContext);
  if (!context) throw new Error('useCurrentUser must be used inside the RecoverBoard app');
  return context;
}
