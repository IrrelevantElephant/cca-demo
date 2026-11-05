# RecoverBoard — Slice 6 Implementation Plan: Task Filtering

## 1. Context & Architectural Overview

Slice 6 adds client-side **Task Filtering** to the RecoverBoard Kanban board so users can filter visible tasks by **Assignee**, **Status**, and **Priority** (individually or combined with AND logic) and reset filters via a **Clear Filters** action.

### Findings from Repository Inspection

- **Frontend (`src/web/src/`)**:
  - [`App.tsx`](../../src/web/src/App.tsx) loads users from `GET /api/users`, manages the persisted active user (`recoverboard.selectedUserId` in `localStorage`), and passes `users` to [`TaskBoard.tsx`](../../src/web/src/TaskBoard.tsx).
  - [`TaskBoard.tsx`](../../src/web/src/TaskBoard.tsx) holds the complete loaded task dataset in `snapshot` (`{ tasks: Task[]; rejected: number } | null`), manages initial/manual refresh (`GET /api/tasks`), coordinates task creation ([`CreateTaskDialog.tsx`](../../src/web/src/CreateTaskDialog.tsx)), task detail editing and deletion ([`TaskDetailsDialog.tsx`](../../src/web/src/TaskDetailsDialog.tsx)), and inline quick-status updates (`PUT /api/tasks/{id}`).
  - [`types.ts`](../../src/web/src/types.ts) defines `User`, `Task`, `TaskStatus` (`'todo' | 'in_progress' | 'done'`), and `TaskPriority` (`'low' | 'medium' | 'high'`).
  - [`App.css`](../../src/web/src/App.css) provides plain CSS layout, form control styles, and mobile responsive rules (`@media (max-width: 600px)`).
- **Backend (`src/`) & Database (`src/database/`)**:
  - No backend endpoints, query parameters, or SQL migrations are required or permitted for Slice 6.
- **Playwright & CI Infrastructure**:
  - [`Dockerfile.playwright`](../../Dockerfile.playwright), [`compose.test.yaml`](../../compose.test.yaml), and [`tests/playwright/playwright.config.ts`](../../tests/playwright/playwright.config.ts) run both `integration` and `smoke` projects inside the shared container image.
  - [`.github/workflows/pipeline.yaml`](../../.github/workflows/pipeline.yaml) runs the isolated Docker Compose integration suite (plus [`scripts/test-task-persistence.sh`](../../scripts/test-task-persistence.sh)) before deployment and the non-destructive smoke suite after deployment.

---

## 2. Filter State & Derived Filtering Logic

### Filter State Representation

Filter state will live locally inside [`TaskBoard`](../../src/web/src/TaskBoard.tsx) using React `useState` hooks (never persisted to `localStorage`, URL parameters, or backend):

```typescript
const [assigneeFilter, setAssigneeFilter] = useState<string>('');
const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>('');
const [priorityFilter, setPriorityFilter] = useState<TaskPriority | ''>('');
```

- `assigneeFilter`: `''` represents **All Users**; otherwise stores the stringified positive integer `user.id` (e.g., `'1'`, `'2'`, `'3'`). Comparing against `task.assigned_to` converts `Number(assigneeFilter)` and checks `Number.isInteger(selectedAssigneeId) && task.assigned_to === selectedAssigneeId`.
- `statusFilter`: `''` represents **All Statuses**; otherwise `'todo' | 'in_progress' | 'done'`.
- `priorityFilter`: `''` represents **All Priorities**; otherwise `'low' | 'medium' | 'high'`.
- `hasActiveFilters`: `Boolean(assigneeFilter || statusFilter || priorityFilter)`.

### Independence from Active User Identity

- Switching the active user in the header (`Working as` / `Current user` select in [`App.tsx`](../../src/web/src/App.tsx)) updates `UserContext` and `localStorage`, but does not reset or alter `assigneeFilter`, `statusFilter`, or `priorityFilter`.
- Full browser page reload (`page.reload()`) remounts the React app, resetting all three filters to `''` (**All Users**, **All Statuses**, **All Priorities**) while restoring `recoverboard.selectedUserId` from `localStorage`.

### Derived Task List

Using `useMemo` in [`TaskBoard.tsx`](../../src/web/src/TaskBoard.tsx), derive `filteredTasks` from `snapshot?.tasks` without mutating or reordering the underlying array:

```typescript
const selectedAssigneeId = assigneeFilter === '' ? null : Number(assigneeFilter);

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
```

- Preserves the exact backend/seed ordering (`created_at ASC, id ASC`) within each column.
- Triggers zero network requests when changing or clearing filters.

---

## 3. Filter Toolbar UI & Styling

### Toolbar Markup in `TaskBoard.tsx`

Add a filtering toolbar above the Kanban columns inside `<section className="board" aria-label="Task board">`:

- Container: `<div className="board-filters" role="group" aria-label="Task filters">` (using `role="group"` so it does not collide with `getByRole('region')` queries used for the three Kanban columns).
- **Filter 1 — Assigned User**:
  - `<label htmlFor="filter-assignee">Assignee</label>`
  - `<select id="filter-assignee" value={assigneeFilter} onChange={...}>`
  - Options:
    - `<option value="">All Users</option>`
    - `{users.map((user) => <option key={user.id} value={String(user.id)}>{user.name}</option>)}`
- **Filter 2 — Status**:
  - `<label htmlFor="filter-status">Status</label>`
  - `<select id="filter-status" value={statusFilter} onChange={...}>`
  - Options:
    - `<option value="">All Statuses</option>`
    - `<option value="todo">To Do</option>`
    - `<option value="in_progress">In Progress</option>`
    - `<option value="done">Done</option>`
  - Note: Each `TaskCard` also has a quick-status `<select>` labeled `Status`. Scoping filter controls inside `.board-filters` (`aria-label="Task filters"`) and giving the filter select `id="filter-status"` allows unambiguous targeting while keeping visible `<label>` elements on all controls.
- **Filter 3 — Priority**:
  - `<label htmlFor="filter-priority">Priority</label>`
  - `<select id="filter-priority" value={priorityFilter} onChange={...}>`
  - Options:
    - `<option value="">All Priorities</option>`
    - `<option value="low">Low</option>`
    - `<option value="medium">Medium</option>`
    - `<option value="high">High</option>`
- **Clear Filters Button**:
  - `<button type="button" className="secondary-button clear-filters-button" onClick={handleClearFilters} disabled={!hasActiveFilters}>Clear Filters</button>`
  - Resets `assigneeFilter`, `statusFilter`, and `priorityFilter` to `''`.
  - Disabled when `!hasActiveFilters`.
  - Kept as a single button in the filter toolbar right above the board/empty-state banner so `getByRole('button', { name: 'Clear Filters' })` always resolves uniquely without Playwright strict-mode collisions.

### Responsive & Accessible Styling (`src/web/src/App.css`)

- Style `.board-filters` as a horizontal flex/grid toolbar on desktop (`display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; margin: 16px 0; padding: 14px 16px; background: #fff; border: 1px solid #dfe5eb; border-radius: 10px;`).
- Style `.filter-field` (`display: flex; flex-direction: column; gap: 6px; min-width: 0;`) with visible label styling matching `.form-field label`.
- On mobile (`@media (max-width: 600px)`), stack filter fields (`width: 100%`, `select { width: 100%; min-width: 0; }`) so there is no horizontal overflow at `320px` viewport width (preserving the `scrollWidth <= 320` check in `tasks.spec.ts`).

---

## 4. Board, Column Counts, Empty States & Error Handling

### Column Headings & Counts

- Each `TaskColumn` receives `tasks={filteredTasks.filter((task) => task.status === status)}`.
- Column headings (`To do (N)`, `In progress (N)`, `Done (N)`) automatically display the count of currently visible (filtered) tasks in that column, and return to unfiltered totals when filters are cleared.
- All three columns remain visible regardless of which status filter is active.

### Empty Board vs. Empty Filtered Results vs. Empty Column

1. **Genuinely Empty Database (No Filters Active)**:
   - When `snapshot && snapshot.tasks.length === 0 && !hasActiveFilters`:
     - Board-level message: `<p>No tasks yet</p>`.
     - Each empty column displays: `<p>No tasks in this column.</p>`.
2. **Filtered Empty Results (Active Filters Match Zero Tasks)**:
   - When `snapshot && hasActiveFilters && filteredTasks.length === 0`:
     - Board-level message: `<p role="status">No tasks match the selected filters.</p>` (and do **not** render `<p>No tasks yet</p>`).
     - The filter toolbar (including the enabled **Clear Filters** button) and all three columns remain visible.
3. **Empty Column Under Active Filters**:
   - Pass `isFiltered={hasActiveFilters}` to `TaskColumn`.
   - When a column has `tasks.length === 0`:
     - If `isFiltered` is `true`, render `<p>No matching tasks in this column.</p>`.
     - If `isFiltered` is `false`, render `<p>No tasks in this column.</p>`.
4. **Loading & API Error States**:
   - If the initial `GET /api/tasks` fails (`snapshot === null` and `error !== ''`), render the existing `role="alert"` error message and `Retry` button; do **not** render `"No tasks match the selected filters."`.
   - If a refresh `GET /api/tasks` fails while `snapshot` exists, display the existing stale-data alert while preserving `assigneeFilter`, `statusFilter`, and `priorityFilter` on the retained snapshot.

---

## 5. Integration with Task Operations

1. **Task Creation (`POST /api/tasks`)**:
   - `handleTaskCreated` continues to set `Task created successfully.` and refresh `snapshot` via `load({ force: true })`.
   - Verification checks `outcome.tasks?.some((task) => task.id === createdTask.id)` against the full refreshed dataset so creation succeeds and shows the success notice even when the new task is hidden by active filters.
   - Active filters are not cleared on creation; the new task appears immediately if and only if it matches all active filters.
2. **Task Editing & Reassignment (`PUT /api/tasks/{id}`)**:
   - `handleTaskSaved` updates `snapshot` via `replaceTaskById(updatedTask)`.
   - `filteredTasks` recalculates synchronously: if the edited task's new `priority`, `assigned_to`, or `status` no longer satisfies active filters, the card disappears from the board (and if its `status` changed while still matching, it moves to the target column and updates both column counts).
   - Focus restoration in `TaskBoard.tsx` already falls back to `Create Task` / `Refresh` when the edited card is no longer mounted in the DOM.
3. **Quick Status Changes (`PUT /api/tasks/{id}`)**:
   - `handleQuickStatusChange` updates `snapshot` via `replaceTaskById(result.task)`.
   - Update the `quick-status` branch of the `focusTarget` `useEffect` in `TaskBoard.tsx` so that if the card is no longer visible (e.g., moved out of a filtered status column), focus falls back cleanly to `Create Task` / `Refresh` just like `card-trigger`.
4. **Task Deletion (`DELETE /api/tasks/{id}`)**:
   - `handleTaskDeleted` and `handleTaskAlreadyGone` remove the task from `snapshot` and refresh.
   - Pass `filteredTasks` into `selectPostDeleteFocusTarget(filteredTasks, deletedTaskId)` so post-delete focus targets the next visible card in the filtered column/board rather than a hidden task.
5. **Manual Refresh (`GET /api/tasks`)**:
   - Clicking `Refresh` calls `load(...)` without resetting `assigneeFilter`, `statusFilter`, or `priorityFilter`.
   - Once refreshed tasks arrive, `filteredTasks` and column counts recompute against the active filters.

---

## 6. Testing Plan (Containerised Playwright & CI)

All tests will be executed via the existing Docker Compose Playwright runner (`Dockerfile.playwright` + `compose.test.yaml`).

### 6.1 Integration Tests (`tests/playwright/integration/task-fixture.spec.ts`)

Extend the serial isolated fixture suite (`tests/playwright/integration/task-fixture.spec.ts`) or add a dedicated spec file that uses the main `app` stack for read-only filter tests and `task-fixture.spec.ts` for mutation-under-filter tests (since `task-fixture.spec.ts` runs against `fixture-app` with `resetFixture()` before/after each test, keeping `app` pristine for parallel read-only specs):

1. **Test 1 — Default Filters**:
   - Verify `Assignee`, `Status`, and `Priority` dropdowns and `Clear Filters` button are visible.
   - Verify defaults: `All Users` (`''`), `All Statuses` (`''`), `All Priorities` (`''`), and `Clear Filters` is disabled.
   - Verify all tasks are visible and column counts match unfiltered task counts.
2. **Test 2 — Filter by Assignee**:
   - Select Bob (`2`); verify only Bob's tasks are rendered, Alice's and Charlie's tasks are hidden, and column counts update.
   - Select `All Users`; verify all tasks and counts are restored.
3. **Test 3 — Filter by Status**:
   - Select `In Progress` (`in_progress`); verify only `In progress` column has cards, all three columns remain visible, and `To do` and `Done` columns show `"No matching tasks in this column."`.
   - Select `All Statuses`; verify all columns restore their tasks.
4. **Test 4 — Filter by Priority**:
   - Select `High` (`high`); verify only high-priority tasks are displayed and medium/low tasks are hidden.
   - Select `All Priorities`; verify all tasks are restored.
5. **Test 5 — Combined Filters (AND Logic)**:
   - Prepare known tasks across assignees, statuses, and priorities.
   - Activate `Assignee` + `Status` + `Priority` combinations that match specific subset(s) and verify only tasks matching all three criteria appear.
   - Test a combination with zero matches.
6. **Test 6 — Clear Filters & Zero Network Requests**:
   - Track `/api/tasks` requests.
   - Activate multiple filters; verify `Clear Filters` becomes enabled.
   - Click `Clear Filters`; verify all dropdowns reset to defaults, all tasks and unfiltered column counts return immediately, and zero additional `/api/tasks` requests were made.
7. **Test 7 — Column Counts**:
   - Verify `To do (N)`, `In progress (N)`, and `Done (N)` headings match visible card counts across single-filter, multi-filter, and cleared states.
8. **Test 8 — Empty Results vs. API Error**:
   - Filter to a combination with no matching tasks (e.g., create/configure known fixture state where a combination has 0 matches); verify `"No tasks match the selected filters."` is visible, `"No tasks yet"` is not shown, all 3 columns remain visible with `"No matching tasks in this column."`, and clicking `Clear Filters` restores the tasks.
   - Verify that when `/api/tasks` fails on initial load, the error alert is shown and `"No tasks match the selected filters."` is not shown.
9. **Test 9 — Task Creation Under Active Filters**:
   - Filter board to Assignee = Charlie.
   - Create a task assigned to Charlie -> verify `"Task created successfully."` and the new card is immediately visible in `To do`.
   - Create a task assigned to Bob -> verify `"Task created successfully."` is shown, the card is hidden while filtered to Charlie, and clicking `Clear Filters` reveals Bob's newly created task.
10. **Test 10 — Task Editing, Reassignment, and Status Changes Under Active Filters**:
    - Filter by Priority = `High`; edit a visible High-priority task to `Low` -> verify it disappears from the filtered view; clear filters -> verify the updated task is present with `Priority: low`.
    - Filter by Assignee = Bob; reassign a visible task from Bob to Alice -> verify it disappears from the filtered view.
    - Filter by Status = `To Do`; change a visible task's status from `todo` to `in_progress` (via dialog and via quick-status select) -> verify it disappears from the filtered view; clear filters -> verify it is in `In progress`.
11. **Test 11 — Task Deletion Under Active Filters**:
    - Filter to show a target task; delete the task through the confirmation dialog -> verify it is removed from the filtered view and its column count decreases by 1.
    - Click `Clear Filters` -> verify the deleted task does not reappear.
12. **Test 12 — Manual Refresh & Page Reload Persistence Behaviour**:
    - Switch active user (`Working as`) to Bob and verify active filters are unaffected.
    - Activate filters and click `Refresh` -> verify `/api/tasks` GET occurs, active filter selections are preserved, and refreshed data remains filtered.
    - Reload the page (`page.reload()`) -> verify filters reset to `All Users`, `All Statuses`, `All Priorities` while `Working as` remains Bob.
13. **Test 13 — Regression & Mobile Layout**:
    - Ensure all existing specs (`application.spec.ts`, `users.spec.ts`, `user-selection.spec.ts`, `tasks.spec.ts`, `task-validation.spec.ts`, `task-resilience.spec.ts`, `task-fixture.spec.ts`) and `scripts/test-task-persistence.sh` pass, including the `320px` mobile viewport no-horizontal-overflow check.

### 6.2 Post-Deployment Smoke Tests (`tests/playwright/smoke/tasks.spec.ts`)

Extend [`tests/playwright/smoke/tasks.spec.ts`](../../tests/playwright/smoke/tasks.spec.ts) with non-destructive read-only filter verification:

- Verify `Assignee`, `Status`, and `Priority` filter controls and `Clear Filters` button render with expected options (`All Users` + loaded users, `All Statuses` / `To Do` / `In Progress` / `Done`, `All Priorities` / `Low` / `Medium` / `High`).
- Install a fail-closed route listener asserting zero non-GET requests are issued.
- Exercise selecting a status (`in_progress`), narrowing with a priority (`high`), and narrowing with an assignee (`users[0].id`), verifying at each step that:
  - Visible cards in each column match `tasks.filter(...)` for the active filter combination.
  - Column heading counts match visible cards.
  - If the active combination (or deployed board) has zero matching tasks, `"No tasks match the selected filters."` (or `"No tasks yet"` when unfiltered and empty) is handled cleanly without errors.
- Click `Clear Filters` and verify the full unfiltered board and column counts are restored with zero network requests.

---

## 7. Files to Modify

1. [`src/web/src/TaskBoard.tsx`](../../src/web/src/TaskBoard.tsx) — Add filter state (`assigneeFilter`, `statusFilter`, `priorityFilter`), filter toolbar UI, derived `filteredTasks`, filtered column counts, filtered empty-board / empty-column messages, and post-mutation focus fallback when cards are filtered out.
2. [`src/web/src/App.css`](../../src/web/src/App.css) — Add `.board-filters`, `.filter-field`, `.clear-filters-button`, and `.empty-filter-state` styles with mobile responsive rules (`@media (max-width: 600px)`).
3. [`tests/playwright/integration/task-fixture.spec.ts`](../../tests/playwright/integration/task-fixture.spec.ts) — Add integration tests covering individual filters, combined filters, clear filters, column counts, empty filtered results, task creation/editing/reassignment/status-transition/deletion under active filters, manual refresh vs. reload persistence, and error resilience.
4. [`tests/playwright/smoke/tasks.spec.ts`](../../tests/playwright/smoke/tasks.spec.ts) — Extend non-destructive smoke tests to verify filter controls, progressive filtering, column count accuracy, empty-board safety, and `Clear Filters`.
5. [`AGENTS.md`](../../AGENTS.md) / [`src/web/AGENTS.md`](../../src/web/AGENTS.md) / [`docs/TESTING.md`](../../docs/TESTING.md) — Update behavioral descriptions if needed to reflect client-side task filtering on the board.

---

## 8. Verification Commands

1. **Frontend Lint & Build**:
   ```sh
   (cd src/web && pnpm lint && pnpm build)
   ```
2. **Backend Unit Tests & Vet**:
   ```sh
   (cd src && go vet ./... && go test ./...)
   ```
3. **Containerised Playwright Integration Suite & Persistence Check**:
   ```sh
   docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration up --build -d app
   docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration run --build --no-deps --rm playwright npm run test:integration
   bash scripts/test-task-persistence.sh recoverboard-test
   docker compose -p recoverboard-test -f src/docker-compose.yaml -f compose.test.yaml --profile integration down -v --remove-orphans
   ```
4. **Containerised Playwright Smoke Suite (against local app target)**:
   ```sh
   docker compose -p recoverboard-smoke-target -f src/docker-compose.yaml -f compose.test.yaml up --build -d app
   BASE_URL=http://app:8080 docker compose -p recoverboard-smoke-target -f src/docker-compose.yaml -f compose.test.yaml run --build --no-deps --rm -e PW_SUITE=smoke -e BASE_URL -e PW_ARTIFACTS_DIR=/artifacts/local-smoke playwright npm run test:smoke
   docker compose -p recoverboard-smoke-target -f src/docker-compose.yaml -f compose.test.yaml down -v --remove-orphans
   ```
