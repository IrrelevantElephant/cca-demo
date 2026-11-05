# RecoverBoard — Slice 7 Implementation Plan: Dashboard Summary and UI Polish

## 1. Context & Repository Inspection

Slice 7 is the final planned slice of core RecoverBoard functionality. It adds a **Dashboard Summary** displaying overall task statistics above the task toolbar and polishes the UI layout, responsive behavior, loading/error/empty states, notifications, and accessibility without introducing new business features, backend endpoints, or database migrations.

### Findings from Repository Inspection

- **Repository Guides (`AGENTS.md`, `src/AGENTS.md`, `src/web/AGENTS.md`)**:
  - Plans belong in `./docs/plans/`.
  - All Playwright integration and smoke tests must run inside the existing Docker Compose container infrastructure (`Dockerfile.playwright`, `compose.test.yaml`).
  - Keep SQL columns, Go JSON fields, and TypeScript contracts aligned. Do not add unrequested business functionality.
- **Frontend (`src/web/src/`)**:
  - [`App.tsx`](../../src/web/src/App.tsx) loads users from `GET /api/users`, persists the active user selection under `recoverboard.selectedUserId` in `localStorage`, handles user-loading/error/empty states, and renders `<TaskBoard users={users} />`.
  - [`TaskBoard.tsx`](../../src/web/src/TaskBoard.tsx) owns the authoritative loaded task dataset in `snapshot` (`{ tasks: Task[]; rejected: number } | null`), manages abortable initial/manual refresh requests (`GET /api/tasks`), maintains client-side filter state (`assigneeFilter`, `statusFilter`, `priorityFilter`), and coordinates task creation ([`CreateTaskDialog.tsx`](../../src/web/src/CreateTaskDialog.tsx)), task detail editing and deletion ([`TaskDetailsDialog.tsx`](../../src/web/src/TaskDetailsDialog.tsx)), and card-level quick status updates (`PUT /api/tasks/{id}`).
  - [`taskApi.ts`](../../src/web/src/taskApi.ts) validates API responses, strips malformed records with safe diagnostics, and returns typed discriminated unions for `fetchTasks`, `fetchTask`, `createTask`, `updateTask`, and `deleteTask`.
  - [`App.css`](../../src/web/src/App.css) and [`index.css`](../../src/web/src/index.css) provide plain CSS styling with a single `@media (max-width: 600px)` breakpoint.
- **Backend (`src/`) & Database (`src/database/`)**:
  - [`main.go`](../../src/main.go) and [`tasks.go`](../../src/tasks.go) already expose `GET /api/users`, `GET /api/tasks`, `POST /api/tasks`, `GET /api/tasks/{id}`, `PUT /api/tasks/{id}`, and `DELETE /api/tasks/{id}` with structured JSON errors (`{ error, message, fields }`).
  - No backend changes or database migrations are needed or permitted in Slice 7.
- **Testing & CI Infrastructure (`tests/playwright/`, `.github/workflows/pipeline.yaml`)**:
  - [`tests/playwright/helpers/board.ts`](../../tests/playwright/helpers/board.ts) verifies Kanban column headings (`To do (N)`, `In progress (N)`, `Done (N)`), cards, and empty-board/empty-filter messages (`No tasks yet`, `No tasks match the selected filters.`, `No tasks in this column.`, `No matching tasks in this column.`).
  - [`tests/playwright/integration/task-fixture.spec.ts`](../../tests/playwright/integration/task-fixture.spec.ts) runs serial end-to-end tests against `fixture-app` and `fixture-database`.
  - [`tests/playwright/smoke/tasks.spec.ts`](../../tests/playwright/smoke/tasks.spec.ts) runs non-destructive checks against `BASE_URL` with a fail-closed route guard blocking non-`GET` requests.

---

## 2. Dashboard Summary Design & Data Derivation

### 2.1 Derived Summary State

In [`TaskBoard.tsx`](../../src/web/src/TaskBoard.tsx), derive dashboard summary counts directly from `snapshot?.tasks` via `useMemo`. Do not maintain separate mutable counter state or issue additional API calls:

```typescript
const summary = useMemo(() => {
  const tasks = snapshot?.tasks ?? [];
  let todo = 0;
  let inProgress = 0;
  let completed = 0;
  for (const task of tasks) {
    if (task.status === 'todo') todo += 1;
    else if (task.status === 'in_progress') inProgress += 1;
    else if (task.status === 'done') completed += 1;
  }
  return {
    total: tasks.length,
    todo,
    inProgress,
    completed,
  };
}, [snapshot]);
```

- When `snapshot` is loaded (`snapshot !== null`), the cards display numeric counts (`summary.total`, `summary.todo`, `summary.inProgress`, `summary.completed`).
- When `snapshot` is `null` (initial load in progress or initial load failed before any valid snapshot was received), the dashboard summary either waits for the initial snapshot or renders placeholder dashes (`—`) so failed initial requests are never misrepresented as `0` tasks in an empty database. Only render the numeric summary cards when `snapshot !== null` (consistent with how the Kanban columns render when `snapshot !== null`), ensuring API failures are never confused with an empty database.

### 2.2 Dashboard Summary Markup & Accessibility

Place the dashboard summary section inside [`TaskBoard.tsx`](../../src/web/src/TaskBoard.tsx) above the task toolbar:

```tsx
{snapshot && (
  <section className="dashboard-summary" aria-label="Dashboard summary">
    <div className="summary-grid">
      <div className="summary-card summary-card-total" data-summary-card="total">
        <span className="summary-label">Total Tasks</span>
        <strong className="summary-value" data-testid="summary-total">{summary.total}</strong>
        <span className="summary-subtext">All board tasks</span>
      </div>
      <div className="summary-card summary-card-todo" data-summary-card="todo">
        <span className="summary-label">To Do</span>
        <strong className="summary-value" data-testid="summary-todo">{summary.todo}</strong>
        <span className="summary-subtext">Awaiting work</span>
      </div>
      <div className="summary-card summary-card-in-progress" data-summary-card="in_progress">
        <span className="summary-label">In Progress</span>
        <strong className="summary-value" data-testid="summary-in-progress">{summary.inProgress}</strong>
        <span className="summary-subtext">Currently active</span>
      </div>
      <div className="summary-card summary-card-completed" data-summary-card="done">
        <span className="summary-label">Completed</span>
        <strong className="summary-value" data-testid="summary-completed">{summary.completed}</strong>
        <span className="summary-subtext">Finished work</span>
      </div>
    </div>
  </section>
)}
```

- Using `<section className="dashboard-summary" aria-label="Dashboard summary">` exposes a single landmark region named `"Dashboard summary"` while individual cards use `<div>` elements (`data-summary-card="total" | "todo" | "in_progress" | "done"`), avoiding any collision with `page.getByRole('region', { name: 'To do (N)' })` in existing tests.
- Each card includes a subtle top or left border accent color aligned with the application palette (`#275d87` brand blue for Total Tasks, `#475467` slate for To Do, `#b54708` amber for In Progress, `#245d36` green for Completed) alongside clear text labels and large numeric counts.

---

## 3. Dashboard & Filter Interaction

- **Dashboard totals always reflect `snapshot.tasks` (all tasks)**:
  - Applying or changing `assigneeFilter`, `statusFilter`, or `priorityFilter` updates `filteredTasks` and the Kanban column counts (`To do (N)`, `In progress (N)`, `Done (N)`), while `summary` (`Total Tasks`, `To Do`, `In Progress`, `Completed`) remains completely unchanged.
  - Clicking `Clear Filters` resets the filter controls and restores the Kanban column counts without altering `summary`.
- **Visual distinction when filters are active**:
  - When `hasActiveFilters` is `true`, render a subtle filter-scope note inside the filter bar (e.g., `<p className="filter-scope-note">Showing {filteredTasks.length} of {summary.total} tasks on board (summary shows all tasks)</p>`) so presenters and viewers can immediately distinguish overall dashboard totals from filtered column counts.

---

## 4. Synchronisation Across Task Operations & Failure Handling

1. **Task Creation (`POST /api/tasks`)**:
   - Do not update `snapshot` while the `POST` request is pending or if it fails/is rejected.
   - When `createTask` confirms `201 Created` (`handleTaskCreated(createdTask)`):
     - Immediately insert `createdTask` into `snapshot.tasks` (if not already present) via functional state update so `Total Tasks` and `To Do` increment by `1` immediately upon API confirmation.
     - Trigger `load({ force: true })` to synchronize with the full server list.
     - If the follow-up `GET /api/tasks` refresh fails, set `postCreateRefreshFailed(true)`, clear `notice` (`setNotice('')`), and display the specific alert (`"Task saved, but the board could not be refreshed. ..."` with `Retry refresh`), preventing contradictory simultaneous success and error banners while keeping the confirmed task in `snapshot`.
2. **Task Editing (`PUT /api/tasks/{id}`)**:
   - When `TaskDetailsDialog` confirms `200 OK` (`handleTaskSaved(updatedTask)`), `replaceTaskById(updatedTask)` updates the task in `snapshot.tasks`.
   - Edits to `title`, `description`, `priority`, or `assigned_to` keep `summary.total`, `summary.todo`, `summary.inProgress`, and `summary.completed` unchanged.
3. **Status Transitions (`PUT /api/tasks/{id}` via Dialog or Quick Status Select)**:
   - When a task's status changes and the API confirms `200 OK`, `replaceTaskById(updatedTask)` updates the task in `snapshot.tasks`.
   - `summary` automatically decreases the previous status count by `1`, increases the new status count by `1`, and keeps `summary.total` unchanged.
   - If the `PUT` fails, `snapshot` is untouched and the dashboard counts do not change.
4. **Task Deletion (`DELETE /api/tasks/{id}`)**:
   - When `deleteTask` confirms `204 No Content` (`handleTaskDeleted(deletedTaskId)`) or reconciles `404 Not Found` (`handleTaskAlreadyGone(missingTaskId)`), `removeTaskById` immediately removes the task from `snapshot.tasks`.
   - `summary.total` and the deleted task's status count each decrease by `1`.
   - If the subsequent background `GET /api/tasks` refresh fails in `handleTaskDeleted`, set `postDeleteRefreshFailed(true)`, clear `notice` (`setNotice('')`), and show `"Task deleted, but the board could not be refreshed. ..."` with `Retry refresh`.
5. **Manual Refresh (`GET /api/tasks`)**:
   - Clicking `Refresh` fetches the latest task list, updates `snapshot`, recalculates `summary`, and preserves `assigneeFilter`, `statusFilter`, and `priorityFilter`.
   - If `Refresh` fails, `snapshot` retains the last known valid task list and `summary` counts, while displaying the stale-data alert (`"Tasks could not be refreshed; showing stale data. ..."`).

---

## 5. Layout, Responsive Design, States & Accessibility Polish

### 5.1 Four-Section Visual Hierarchy

Refine [`App.tsx`](../../src/web/src/App.tsx), [`TaskBoard.tsx`](../../src/web/src/TaskBoard.tsx), and [`App.css`](../../src/web/src/App.css) into four clean, presentation-ready sections:

1. **Header (`.topbar` + `.workspace-header`)**:
   - Brand mark, `<h1>RecoverBoard</h1>`, subtitle `Team Task Management`, and `Working as` user selector (`#user-select`, `aria-label="Current user"`).
   - Compact `.current-user` indicator (`Currently working as <strong>{selectedUser?.name}</strong>`).
2. **Dashboard Summary (`.dashboard-summary`)**:
   - Four summary cards (`Total Tasks`, `To Do`, `In Progress`, `Completed`) in `.summary-grid`.
3. **Task Toolbar (`.board-toolbar`)**:
   - Action row (`.board-tools`) with status/loading announcement (`role="status"`), `Create Task` primary button, and `Refresh`/`Retry` button.
   - Filter bar (`.board-filters`, `role="group"`, `aria-label="Task filters"`) with `Assignee`, `Status`, `Priority` selects and `Clear Filters` button.
4. **Kanban Board (`.columns`)**:
   - Three columns (`To do`, `In progress`, `Done`) with task counts, cards, priority badges, assignee labels, and quick-status selectors.

### 5.2 Responsive Breakpoints (`App.css`)

- **Desktop (`>= 1024px`, including `1280px` presentation width)**:
  - `.summary-grid`: 4 columns (`grid-template-columns: repeat(4, minmax(0, 1fr))`).
  - `.columns`: 3 columns (`grid-template-columns: repeat(3, minmax(0, 1fr))`).
  - `.board-filters`: horizontal flex row with aligned control heights.
- **Tablet (`601px` to `1023px`)**:
  - `.summary-grid`: 2×2 grid (`grid-template-columns: repeat(2, minmax(0, 1fr))`).
  - `.columns`: adapts smoothly (`grid-template-columns: repeat(auto-fit, minmax(260px, 1fr))` or stacked at narrower tablet widths so cards never become unusably narrow).
- **Mobile (`<= 600px`, down to `320px` width)**:
  - `.summary-grid`: compact 2×2 grid (`grid-template-columns: repeat(2, minmax(0, 1fr))`, `gap: 10px`) so all four summary metrics remain visible at a glance without excessive vertical scrolling.
  - `.board-tools` and `.board-filters`: full-width stacked/wrapped controls.
  - `.columns`: single-column vertical stack (`grid-template-columns: minmax(0, 1fr)`).
  - `.task-dialog`: fits within viewport (`width: min(520px, calc(100vw - 24px))`, `max-height: calc(100vh - 24px)`, `overflow-y: auto`) with zero horizontal page overflow (`document.documentElement.scrollWidth <= window.innerWidth`).

### 5.3 Loading, Error, Notification & Empty State Consistency

- **Notifications & Loading (`role="status"`)**:
  - Style `.board-tools [role="status"]` as a clean, non-blocking inline status pill so `"Loading tasks…"`, `"Refreshing tasks…"`, `"Task created successfully."`, `"Task updated successfully."`, `"Task status updated."`, `"Task deleted."`, and `"Task no longer exists on the server; board updated."` have a consistent visual appearance while preserving exact text assertions in existing Playwright tests.
- **Error Banners (`role="alert"`)**:
  - Style board-level error alerts (`.board-alert`) consistently with dialog alerts (`.dialog-alert`), providing clear retry buttons (`Retry` or `Retry refresh`).
- **Empty States**:
  - **Empty Database (`!hasActiveFilters && snapshot.tasks.length === 0`)**:
    Render a styled empty-board container containing `<p className="empty-board-title">No tasks yet</p>` and `<p className="empty-board-subtitle">Create your first task to get started.</p>`. Keeping `<p className="empty-board-title">No tasks yet</p>` as a distinct paragraph preserves `page.getByText('No tasks yet', { exact: true })` in `tests/playwright/helpers/board.ts` while providing the helpful onboarding prompt.
  - **No Filter Matches (`hasActiveFilters && filteredTasks.length === 0`)**:
    Render `<p className="empty-filter-results">No tasks match the selected filters.</p>` while keeping all four dashboard summary cards displaying the complete dataset counts and `Clear Filters` enabled.
  - **Empty Column**:
    Keep `<p className="empty-column-message">{isFiltered ? 'No matching tasks in this column.' : 'No tasks in this column.'}</p>`.

### 5.4 Accessibility & UI Consistency

- Verify heading hierarchy (`<h1>RecoverBoard</h1>`, `<h2>` for column/dialog headings, `<h3>` for task card titles and delete confirmation heading).
- Ensure all form controls (`#user-select`, `#filter-assignee`, `#filter-status`, `#filter-priority`, `#quick-status-{id}`, dialog inputs/selects/textarea) have explicit `<label htmlFor>` associations and consistent heights/padding/border-radius.
- Preserve keyboard operability, `:focus-visible` outlines (`outline: 3px solid #275d87` / `#a8cae5`), modal dialog focus trapping, `Escape` handling, and post-close/post-delete focus restoration.

---

## 6. Testing Plan (Containerised Playwright & CI)

### 6.1 Shared Board Helper Update (`tests/playwright/helpers/board.ts`)

Add an exported `expectDashboardSummary(page: Page, allTasks: ApiTask[])` helper in [`tests/playwright/helpers/board.ts`](../../tests/playwright/helpers/board.ts):

- Verifies `<section aria-label="Dashboard summary">` is visible.
- Verifies all four summary cards (`Total Tasks`, `To Do`, `In Progress`, `Completed`) are visible with their expected labels and exact numeric counts derived from `allTasks`:
  - `Total Tasks`: `allTasks.length`
  - `To Do`: `allTasks.filter(t => t.status === 'todo').length`
  - `In Progress`: `allTasks.filter(t => t.status === 'in_progress').length`
  - `Completed`: `allTasks.filter(t => t.status === 'done').length`
- In `expectBoard(page, tasks, users, options)`, when `!options?.filtered`, also assert `expectDashboardSummary(page, tasks)` so every unfiltered board verification automatically validates dashboard summary accuracy.

### 6.2 Integration Tests (`tests/playwright/integration/task-fixture.spec.ts`)

Add comprehensive integration tests covering all Slice 7 requirements against the real Go API and isolated PostgreSQL fixture:

1. **Integration Test 1 — Dashboard Loads**:
   - Verify all four summary cards (`Total Tasks`, `To Do`, `In Progress`, `Completed`) are visible, labels are accurate, counts are numeric, and counts match `GET /api/tasks`.
2. **Integration Test 2 — Dashboard Ignores Filters**:
   - Record initial dashboard totals, apply an assignee filter, verify Kanban column counts change while dashboard totals remain unchanged, apply additional status and priority filters (including a 0-match filter combination), verify dashboard totals still remain unchanged, and click `Clear Filters` to restore the full board.
3. **Integration Test 3 — Task Creation Updates Summary**:
   - Create a new task via `Create Task` dialog; verify `Total Tasks` increases by 1, `To Do` increases by 1, `In Progress` and `Completed` remain unchanged, and counts persist after manual `Refresh` and browser `page.reload()`.
4. **Integration Test 4 — Status Changes Update Summary**:
   - Move the created task from `To Do` to `In Progress` (via quick-status select or dialog), verifying `To Do` decreases by 1, `In Progress` increases by 1, and `Total Tasks` is unchanged; then move it from `In Progress` to `Done`, verifying `In Progress` decreases by 1, `Completed` increases by 1, and `Total Tasks` remains unchanged.
5. **Integration Test 5 — Task Editing Does Not Change Counts**:
   - Edit a task's title, description, priority, and assignee in `Task Details` without changing status; verify all four dashboard summary counts remain unchanged.
6. **Integration Test 6 — Deletion Updates Summary**:
   - Delete a task via `Task Details` -> `Delete task` confirmation; verify `Total Tasks` decreases by 1, the corresponding status count decreases by 1, and counts remain accurate after manual `Refresh` and `page.reload()`.
7. **Integration Test 7 — Refresh Updates Summary**:
   - With active filters applied on the board, insert/update/delete tasks in PostgreSQL and click `Refresh`; verify dashboard totals update to reflect the complete refreshed dataset while active filters remain selected and board column counts reflect filtered results.
8. **Integration Test 8 — Empty Database**:
   - With `DELETE FROM tasks;` on the isolated fixture database, verify all four dashboard summary cards show `0`, `"No tasks yet"` and `"Create your first task to get started."` are visible, and `Create Task` remains enabled and functional.
9. **Integration Test 9 — API Failure Resilience**:
   - Simulate initial `GET /api/tasks` failure via route interception: verify visible error alert, verify neither `"No tasks yet"` nor misleading zero summary cards are shown, and verify recovery via `Retry`.
   - Simulate failed manual `Refresh` after tasks are loaded: verify error alert, verify stale dashboard summary counts and board cards are preserved, and verify recovery on subsequent `Refresh`.
10. **Integration Test 10 — Responsive Layout**:
    - Test desktop (`1280×800`), tablet (`768×900`), and mobile (`375×667` and `320×700`) viewports: verify all four dashboard summary cards, toolbar controls, Kanban columns, and dialogs remain visible and usable with zero unintended horizontal overflow (`scrollWidth <= viewportWidth`).
11. **Integration Test 11 — Accessibility**:
    - Verify accessible names on all interactive controls (`Current user`, `Assignee`, `Status`, `Priority`, `Create Task`, `Refresh`, `Clear Filters`, dialog inputs/buttons), keyboard navigation (`Tab`, `Shift+Tab`, `Enter`, `Escape`), focus restoration on dialog close/delete, and accessible `role="status"` / `role="alert"` announcements.
12. **Integration Test 12 — Regression**:
    - Run the complete existing integration suite (`application.spec.ts`, `users.spec.ts`, `user-selection.spec.ts`, `tasks.spec.ts`, `task-validation.spec.ts`, `task-resilience.spec.ts`, `task-fixture.spec.ts`) and `scripts/test-task-persistence.sh`.

### 6.3 Post-Deployment Smoke Tests (`tests/playwright/smoke/tasks.spec.ts`)

Extend [`tests/playwright/smoke/tasks.spec.ts`](../../tests/playwright/smoke/tasks.spec.ts) while keeping the suite strictly non-destructive:

- **Dashboard Availability & Consistency**:
  - Verify all four dashboard summary cards render with valid non-negative integers, `Total Tasks === To Do + In Progress + Completed`, and counts match the captured `GET /api/tasks` response payload.
- **Filtering Interaction**:
  - Verify that applying assignee, status, and priority filters changes visible board column counts while all four dashboard summary counts remain unchanged, and `Clear Filters` restores the unfiltered board.
- **Responsive Layout**:
  - Verify clean rendering and zero horizontal overflow (`scrollWidth <= viewportWidth`) at both desktop (`1280×800`) and mobile (`375×667`) viewports.

---

## 7. Files to Create or Modify

- `docs/plans/slice-7-dashboard-summary-and-ui-polish.md` (this implementation plan)
- `src/web/src/TaskBoard.tsx` (dashboard summary derivation and markup, immediate confirmed-create snapshot update, non-contradictory partial-refresh error state, empty-state subtitle, filter scope indicator, toolbar grouping)
- `src/web/src/App.css` (dashboard summary card styles, tablet & mobile responsive breakpoints, unified toolbar/alert/status/empty-state polish)
- `src/web/AGENTS.md` and `AGENTS.md` (update scoped documentation if needed to note the dashboard summary)
- `tests/playwright/helpers/board.ts` (add `expectDashboardSummary` helper)
- `tests/playwright/integration/task-fixture.spec.ts` (add Slice 7 integration tests for dashboard summary, filter independence, CRUD/refresh count updates, empty DB, API failure resilience, responsive viewports, and accessibility)
- `tests/playwright/smoke/tasks.spec.ts` (extend non-destructive smoke tests for dashboard summary, filter invariance, and desktop/mobile responsive checks)

---

## 8. Verification Commands

1. **Frontend Typecheck, Lint & Production Build**:
   ```bash
   cd src/web && pnpm lint && pnpm build
   ```
2. **Backend Vet & Unit/Contract Tests**:
   ```bash
   cd src && go vet ./... && go test ./...
   ```
3. **Containerised Playwright Integration Suite & Persistence Gate**:
   ```bash
   docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration up --build -d app
   docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration run --build --no-deps --rm playwright npm run test:integration
   bash scripts/test-task-persistence.sh recoverboard-test
   docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration down -v --remove-orphans
   ```
4. **Containerised Playwright Smoke Suite (against local stack)**:
   ```bash
   BASE_URL=http://app:8080 docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration run --build --no-deps --rm -e PW_SUITE=smoke -e BASE_URL=http://app:8080 playwright npm run test:smoke
   ```
