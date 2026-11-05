import { useEffect, useMemo, useRef, useState } from 'react';
import { UserContext } from './types';
import TaskBoard from './TaskBoard';
import type { User } from './types';
import './App.css';
const storageKey = 'recoverboard.selectedUserId';

export default function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [demoEnabled, setDemoEnabled] = useState(false);
  const [breakDialog, setBreakDialog] = useState(false);
  const [breaking, setBreaking] = useState(false);
  const [incidentAck, setIncidentAck] = useState('');
  const breakDialogRef = useRef<HTMLDialogElement>(null);

  const loadUsers = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/users');
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const result: User[] = await response.json();
      if (!Array.isArray(result) || result.some((user) => !user || typeof user.id !== 'number' || typeof user.name !== 'string' || typeof user.role !== 'string')) {
        throw new Error('The server returned an invalid user list.');
      }
      setUsers(result);
      const savedId = Number(localStorage.getItem(storageKey));
      const restored = result.find((user) => user.id === savedId);
      const selected = restored ?? result[0] ?? null;
      setCurrentUser(selected);
      if (selected) localStorage.setItem(storageKey, String(selected.id));
      else localStorage.removeItem(storageKey);
    } catch {
      setError('We couldn’t load team members. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadUsers(); void fetch('/api/demo/config').then((response) => response.ok ? response.json() : null).then((config: { enabled?: boolean } | null) => setDemoEnabled(config?.enabled === true)).catch(() => setDemoEnabled(false)); }, []);
  useEffect(() => { const dialog = breakDialogRef.current; if (breakDialog && dialog && !dialog.open) dialog.showModal(); else if (!breakDialog && dialog?.open) dialog.close(); }, [breakDialog]);
  const triggerIncident = async () => {
    setBreaking(true);
    try {
      const response = await fetch('/api/demo/break', { method: 'POST' });
      if (!response.ok) throw new Error('Request failed');
      setBreakDialog(false);
      setIncidentAck("Well, that wasn't supposed to happen.");
    } catch { setIncidentAck('We couldn’t activate the demo. Please try again.'); }
    finally { setBreaking(false); }
  };
  const changeUser = (user: User) => {
    setCurrentUser(user);
    localStorage.setItem(storageKey, String(user.id));
  };
  const contextValue = useMemo(() => ({ users, selectedUser, setSelectedUser: changeUser }), [users, selectedUser]);

  return (
    <UserContext.Provider value={contextValue}>
      <div className="app-shell">
        <header className="topbar">
          <div className="brand"><span className="brand-mark" aria-hidden="true">R</span><div><h1>RecoverBoard</h1><p>Team Task Management</p></div></div>
          <a className="source-link" href="https://github.com/irrelevantElephant/cca-demo" target="_blank" rel="noreferrer">View source on GitHub</a>
          <div className="identity">
            <label htmlFor="user-select">Working as</label>
            {error ? <button className="retry" onClick={() => void loadUsers()}>Retry</button> : (
              <select id="user-select" aria-label="Current user" disabled={loading || users.length === 0} value={selectedUser?.id ?? ''} onChange={(event) => { const user = users.find((item) => item.id === Number(event.target.value)); if (user) changeUser(user); }}>
                {loading && <option value="">Loading users…</option>}
                {!loading && users.length === 0 && <option value="">No users available</option>}
                {users.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.role}</option>)}
              </select>
            )}
          </div>
          <dialog ref={breakDialogRef} className="task-dialog" aria-labelledby="break-dialog-title" onCancel={() => setBreakDialog(false)}>
            <div className="task-form"><div className="dialog-header"><h2 id="break-dialog-title">Are you sure?</h2></div><p>You’re about to deliberately break RecoverBoard. Things are going to get interesting.</p><div className="dialog-actions"><button className="secondary-button" type="button" disabled={breaking} onClick={() => setBreakDialog(false)}>Cancel</button><button className="danger-button" type="button" disabled={breaking} onClick={() => void triggerIncident()}>💥 Break It!</button></div></div>
          </dialog>
        </header>
        {incidentAck && <p className="incident-ack" role="status">{incidentAck}</p>}
        <main className="main-content">
          {loading ? <div className="state-card" role="status">Loading team members…</div> : error ? <div className="state-card error" role="alert"><p>{error}</p><button onClick={() => void loadUsers()}>Retry</button></div> : users.length === 0 ? <div className="state-card">No team members are available right now.</div> : (
            <div className="workspace"><div className="workspace-header"><div className="current-user">Currently working as <strong>{selectedUser?.name}</strong></div></div><TaskBoard users={users} /></div>
          )}
        </main>
        {demoEnabled && <button className="break-app-button" type="button" onClick={() => setBreakDialog(true)}>💥 Break App</button>}
      </div>
    </UserContext.Provider>
  );
}
