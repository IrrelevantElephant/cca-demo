import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { assertTask, assertTasks, getTasks, getUsers } from '../helpers/api';
import { expectBoard, expectDashboardSummary } from '../helpers/board';
import { fixtureURL, migrate, resetFixture, sql, waitForFixture } from '../helpers/fixture';

test.describe('isolated real-data fixture and task creation', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ request }) => {
    resetFixture();
    await waitForFixture(request);
  });

  test.afterEach(async ({ request }) => {
    resetFixture();
    await waitForFixture(request);
  });

  test.afterAll(() => {
    resetFixture();
  });

  test('dashboard summary tracks confirmed mutations, failures, filters and responsive keyboard dialogs', async ({ page, request }) => {
    const users = await getUsers(request, fixtureURL);
    let failGet = true;
    await page.route('**/api/tasks', async route => {
      if (failGet && route.request().method() === 'GET') await route.abort();
      else await route.continue();
    });
    await page.goto(fixtureURL);
    await expect(page.getByRole('alert')).toContainText('Tasks could not be loaded.');
    await expect(page.getByRole('region', { name: 'Dashboard summary' })).toHaveCount(0);
    await expect(page.getByText('No tasks yet', { exact: true })).toHaveCount(0);
    failGet = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    let tasks = await getTasks(request, fixtureURL);
    await expectBoard(page, tasks, users);
    for (const viewport of [
      { width: 1280, height: 800 }, { width: 768, height: 900 },
      { width: 375, height: 667 }, { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await expectDashboardSummary(page, tasks);
      await expect(page.getByLabel('Current user')).toBeVisible();
      await expect(page.getByRole('group', { name: 'Task filters' })).toBeVisible();
      await page.getByRole('button', { name: 'Create Task', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Title')).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.locator(':focus')).toHaveCount(1);
      await page.keyboard.press('Tab');
      await expect(dialog.getByLabel('Title')).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toBeFocused();
    }
    failGet = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('showing stale data');
    await expectDashboardSummary(page, tasks);
    failGet = false;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expectBoard(page, tasks, users);

    // A confirmed create survives a failed background refresh without contradictory notices.
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Title').fill('Dashboard lifecycle');
    failGet = true;
    await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Task saved, but');
    await expect(page.getByText('Task created successfully.', { exact: true })).toHaveCount(0);
    tasks = await getTasks(request, fixtureURL);
    await expectDashboardSummary(page, tasks);
    failGet = false;
    await page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
    await expectBoard(page, tasks, users);
    const created = tasks.find(t => t.title === 'Dashboard lifecycle')!;
    for (const status of ['in_progress', 'done'] as const) {
      await page.locator(`[data-task-id="${created.id}"]`).getByLabel('Status').selectOption(status);
      await expect(page.getByRole('status')).toHaveText('Task status updated.');
      tasks = await getTasks(request, fixtureURL);
      await expectDashboardSummary(page, tasks);
    }
    await page.locator(`[data-task-id="${created.id}"] .task-card-trigger`).click();
    await dialog.getByLabel('Title').fill('Dashboard edited');
    await dialog.getByLabel('Description').fill('Non-status edit');
    await dialog.getByLabel('Priority').selectOption('high');
    await dialog.getByLabel('Assignee').selectOption(String(users[1].id));
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toHaveCount(0);
    await expectDashboardSummary(page, tasks);
    await page.locator(`[data-task-id="${created.id}"] .task-card-trigger`).click();
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    failGet = true;
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Task deleted, but');
    await expect(page.getByText('Task deleted.', { exact: true })).toHaveCount(0);
    tasks = await getTasks(request, fixtureURL);
    await expectDashboardSummary(page, tasks);
    failGet = false;
    await page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
    await expectBoard(page, tasks, users);
    await page.reload();
    await expectBoard(page, tasks, users);

    const filters = page.getByRole('group', { name: 'Task filters' });
    await filters.getByLabel('Assignee').selectOption(String(users[0].id));
    await filters.getByLabel('Status').selectOption('todo');
    await filters.getByLabel('Priority').selectOption('high');
    await expectDashboardSummary(page, tasks);
    sql("UPDATE tasks SET status = 'done';");
    tasks = await getTasks(request, fixtureURL);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expectDashboardSummary(page, tasks);
    await expectBoard(page, [], users, { filtered: true });
    await expect(filters.getByLabel('Assignee')).toHaveValue(String(users[0].id));
    await expect(filters.getByLabel('Status')).toHaveValue('todo');
    await expect(filters.getByLabel('Priority')).toHaveValue('high');
    await filters.getByRole('button', { name: 'Clear Filters' }).click();
    await expectBoard(page, tasks, users);
    sql('DELETE FROM tasks;');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expectBoard(page, [], users);
    await expect(page.getByText('Create your first task to get started.')).toBeVisible();
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    await dialog.getByLabel('Title').fill('First task');
    await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expectBoard(page, await getTasks(request, fixtureURL), users);
  });

  test('fresh install, Slice 2 upgrade, migration 003 NOT VALID preservation, replay and constraints', async ({ request }) => {
    sql('DROP TABLE IF EXISTS tasks, seed_metadata; DROP TABLE IF EXISTS users;');
    migrate();
    expect(sql('SELECT count(*) FROM tasks')).toBe('10');
    expect(sql("SELECT count(*) FROM seed_metadata WHERE seed_key = 'recoverboard:slice2:tasks'")).toBe('1');
    // Fresh fixture rows satisfy both length constraints when validated.
    sql('ALTER TABLE tasks VALIDATE CONSTRAINT tasks_title_max_length_check; ALTER TABLE tasks VALIDATE CONSTRAINT tasks_description_max_length_check;');

    // Simulate upgrade from Slice 2/3/4 with a pre-existing populated tasks table (and no seed_metadata table)
    // including a historical overlength row and a missing seed task:
    // migration records seed_metadata without resurrecting deleted seeds, and 003 (NOT VALID) preserves legacy data.
    sql('DROP TABLE IF EXISTS tasks, seed_metadata; DROP TABLE IF EXISTS users;');
    sql(`
      BEGIN;
      \\i /fixtures/database/schema.sql
      CREATE TABLE tasks (
          id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
          description TEXT,
          status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done')),
          priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
          assigned_to INTEGER NOT NULL REFERENCES users(id),
          created_by INTEGER NOT NULL REFERENCES users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          seed_key TEXT UNIQUE
      );
      INSERT INTO tasks(title,description,status,priority,assigned_to,created_by,seed_key)
        VALUES ('Surviving seed',NULL,'todo','high',1,3,'recoverboard:slice2:01');
      INSERT INTO tasks(title,description,status,priority,assigned_to,created_by)
        VALUES (repeat('L', 205), repeat('D', 2005), 'todo', 'low', 1, 1);
      COMMIT;
    `);
    migrate();
    expect(sql("SELECT count(*) FROM seed_metadata WHERE seed_key = 'recoverboard:slice2:tasks'")).toBe('1');
    expect(sql('SELECT count(*) FROM tasks')).toBe('2');
    expect(sql('SELECT count(*) FROM tasks WHERE char_length(title) = 205')).toBe('1');
    expect(() => sql(`INSERT INTO tasks(title,status,priority,assigned_to,created_by) VALUES (repeat('N', 201), 'todo', 'low', 1, 1);`)).toThrow();
    expect(() => sql(`INSERT INTO tasks(title,description,status,priority,assigned_to,created_by) VALUES ('Valid', repeat('N', 2001), 'todo', 'low', 1, 1);`)).toThrow();

    // Simulate upgrade from a pre-existing EMPTY tasks table (where all tasks were previously deleted):
    // migration must recognize the existing table, record seed_metadata, and keep 0 tasks without re-seeding.
    sql('DROP TABLE IF EXISTS tasks, seed_metadata;');
    sql(`
      CREATE TABLE tasks (
          id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
          description TEXT,
          status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done')),
          priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
          assigned_to INTEGER NOT NULL REFERENCES users(id),
          created_by INTEGER NOT NULL REFERENCES users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          seed_key TEXT UNIQUE
      );
    `);
    migrate();
    expect(sql("SELECT count(*) FROM seed_metadata WHERE seed_key = 'recoverboard:slice2:tasks'")).toBe('1');
    expect(sql('SELECT count(*) FROM tasks')).toBe('0');

    // Deliberate fresh reset (dropping tasks and seed_metadata) while preserving unrelated user rows seeds once.
    sql('DROP TABLE IF EXISTS tasks, seed_metadata; INSERT INTO users VALUES (99, \'Unrelated user\', \'Tester\');');
    migrate();
    expect(sql('SELECT name FROM users WHERE id=99')).toBe('Unrelated user');
    expect(sql('SELECT count(*) FROM tasks')).toBe('10');
    sql("UPDATE tasks SET title='Edited seed', updated_at='2020-01-01Z' WHERE seed_key='recoverboard:slice2:01'; INSERT INTO tasks(title,status,priority,assigned_to,created_by) VALUES ('Ordinary task','todo','low',99,1);");
    const snapshot = sql('SELECT json_agg(t ORDER BY id) FROM tasks t');
    migrate();
    expect(sql('SELECT json_agg(t ORDER BY id) FROM tasks t')).toBe(snapshot);

    // Deleting one seed task survives migration replay without resurrection.
    sql("DELETE FROM tasks WHERE seed_key='recoverboard:slice2:02'");
    migrate();
    expect(sql('SELECT count(*) FROM tasks')).toBe('10');
    expect(sql("SELECT count(*) FROM tasks WHERE seed_key='recoverboard:slice2:02'")).toBe('0');

    // Deleting all remaining seed tasks also survives migration replay without resurrection.
    sql('DELETE FROM tasks WHERE seed_key IS NOT NULL');
    migrate();
    expect(sql('SELECT count(*) FROM tasks')).toBe('1');
    expect(sql('SELECT title FROM tasks')).toBe('Ordinary task');

    // Reset to fresh seeded state (preserving user 99) for constraint and ordering checks below.
    sql('DROP TABLE IF EXISTS tasks, seed_metadata;');
    migrate();
    sql("UPDATE tasks SET title='Edited seed', updated_at='2020-01-01Z' WHERE seed_key='recoverboard:slice2:01'; INSERT INTO tasks(title,status,priority,assigned_to,created_by) VALUES ('Ordinary task','todo','low',99,1);");
    const invalidRows = [
      "NULL,'todo','low',1,1", "' ','todo','low',1,1",
      "repeat('x', 201),'todo','low',1,1",
      "'Bad','invalid','low',1,1", "'Bad','todo','invalid',1,1",
      "'Bad',NULL,'low',1,1", "'Bad','todo',NULL,1,1",
      "'Bad','todo','low',NULL,1", "'Bad','todo','low',1,NULL",
      "'Bad','todo','low',999,1", "'Bad','todo','low',1,999",
    ];
    for (const row of invalidRows) {
      expect(() => sql(`INSERT INTO tasks(title,status,priority,assigned_to,created_by) VALUES (${row});`)).toThrow();
    }
    expect(() => sql('DELETE FROM users WHERE id=99')).toThrow();
    expect(() => sql("UPDATE tasks SET created_at=NULL WHERE seed_key='recoverboard:slice2:01'")).toThrow();
    expect(() => sql("UPDATE tasks SET updated_at=NULL WHERE seed_key='recoverboard:slice2:01'")).toThrow();
    expect(() => sql("UPDATE tasks SET seed_key='recoverboard:slice2:01' WHERE seed_key='recoverboard:slice2:02'")).toThrow();
    sql("UPDATE tasks SET created_at='2024-01-01T00:00:00.000002Z' WHERE seed_key='recoverboard:slice2:01'; UPDATE tasks SET created_at='2024-01-01T00:00:00.000001Z' WHERE seed_key='recoverboard:slice2:02';");
    const response = await request.get(`${fixtureURL}/api/tasks`);
    expect(response.status()).toBe(200);
    const tasks = await response.json();
    expect(tasks.map((task: { id: number }) => task.id)).toEqual(JSON.parse(sql('SELECT json_agg(id ORDER BY created_at,id) FROM tasks')));
    expect(tasks.some((task: { description: unknown }) => task.description === null)).toBe(true);
    expect(tasks[0].title).toBe('Audit dependencies');
    expect(tasks[1].title).toBe('Edited seed');
  });

  test('empty board, empty columns and SQL-driven refresh use the real backend', async ({ page, request }) => {
    sql('DELETE FROM tasks;');
    const empty = await request.get(`${fixtureURL}/api/tasks`);
    expect(empty.status()).toBe(200);
    expect(await empty.json()).toEqual([]);
    await page.goto(fixtureURL);
    await expect(page.getByText('No tasks yet', { exact: true })).toBeVisible();
    for (const label of ['To do', 'In progress', 'Done']) {
      await expect(page.getByRole('heading', { name: `${label} (0)`, exact: true })).toBeVisible();
    }
    await expect(page.getByText('No tasks in this column.', { exact: true })).toHaveCount(3);
    await page.getByLabel('Current user').selectOption('2');
    await page.evaluate(() => { (window as unknown as { fixtureMarker: string }).fixtureMarker = 'same-document'; });
    sql("INSERT INTO tasks(title,description,status,priority,assigned_to,created_by) VALUES ('Fixture task',NULL,'todo','high',2,1);");
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('heading', { name: 'Fixture task', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'To do (1)', exact: true })).toBeVisible();
    await expect(page.getByText('No tasks yet', { exact: true })).toHaveCount(0);
    await expect(page.getByText('No tasks in this column.', { exact: true })).toHaveCount(2);
    sql("UPDATE tasks SET title='Updated fixture',status='done',updated_at=CURRENT_TIMESTAMP;");
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('heading', { name: 'Updated fixture', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Done (1)', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'To do (0)', exact: true })).toBeVisible();
    await expect(page.getByLabel('Current user')).toHaveValue('2');
    expect(await page.evaluate(() => localStorage.getItem('recoverboard.selectedUserId'))).toBe('2');
    expect(await page.evaluate(() => (window as unknown as { fixtureMarker: string }).fixtureMarker)).toBe('same-document');
  });

  test('Alice creates a high-priority task assigned to Bob and it persists across reload and detail/list APIs', async ({ page, request }) => {
    const users = await getUsers(request, fixtureURL);
    const beforeTasks = await getTasks(request, fixtureURL);
    const beforeTodoCount = beforeTasks.filter(t => t.status === 'todo').length;

    await page.goto(fixtureURL);
    await expectBoard(page, beforeTasks, users);
    await expect(page.getByLabel('Current user')).toHaveValue('1');

    const uniqueTitle = `Alice task ${randomUUID()}`;
    const multilineDesc = 'First line of recovery notes\n  Second indented line';

    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.creating-as')).toHaveText('Creating as Alice');

    await dialog.getByLabel('Title').fill(`  ${uniqueTitle}  `);
    await dialog.getByLabel('Description').fill(multilineDesc);
    await dialog.getByLabel('Priority').selectOption('high');
    await dialog.getByLabel('Assignee').selectOption('2');

    const postPromise = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'POST');
    const refreshPromise = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'GET');
    await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();

    const postResponse = await postPromise;
    expect(postResponse.status()).toBe(201);
    const created = assertTask(await postResponse.json());
    expect(postResponse.headers()['location']).toBe(`/api/tasks/${created.id}`);
    expect(created).toMatchObject({
      title: uniqueTitle,
      description: multilineDesc,
      status: 'todo',
      priority: 'high',
      assigned_to: 2,
      created_by: 1,
    });
    expect(created.created_at).toBe(created.updated_at);

    await refreshPromise;
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toBeFocused();
    await expect(page.getByRole('status')).toHaveText('Task created successfully.');
    await expect(page.getByRole('heading', { name: `To do (${beforeTodoCount + 1})`, exact: true })).toBeVisible();

    const card = page.locator(`.task-card[data-task-id="${created.id}"]`);
    await expect(card.getByRole('heading')).toHaveText(uniqueTitle);
    await expect(card).toContainText('Priority: high');
    await expect(card).toContainText('Assigned to: Bob');
    await expect(card.locator('.task-description')).toHaveText(multilineDesc);

    const detailResponse = await request.get(`${fixtureURL}${postResponse.headers()['location']}`);
    expect(detailResponse.status()).toBe(200);
    expect(await detailResponse.json()).toEqual(created);

    const afterTasks = await getTasks(request, fixtureURL);
    expect(afterTasks.some(t => t.id === created.id)).toBe(true);
    await expectBoard(page, afterTasks, users);

    await page.reload();
    await expectBoard(page, afterTasks, users);
  });

  test('captures creator defaults, preserves open creator/assignee across context changes, supports omitted description and resets on reopen', async ({ page, request }) => {
    const users = await getUsers(request, fixtureURL);
    await page.goto(fixtureURL);
    await expect(page.getByLabel('Current user')).toHaveValue('1');

    // Open as Alice: verify defaults.
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog.locator('.creating-as')).toHaveText('Creating as Alice');
    await expect(dialog.getByLabel('Priority')).toHaveValue('medium');
    await expect(dialog.getByLabel('Assignee')).toHaveValue('1');
    await dialog.getByLabel('Title').fill('Unsaved draft');
    await dialog.getByLabel('Assignee').selectOption('3');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Switch to Bob and reopen: verify fresh defaults for Bob.
    await page.getByLabel('Current user').selectOption('2');
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    await expect(dialog.locator('.creating-as')).toHaveText('Creating as Bob');
    await expect(dialog.getByLabel('Title')).toHaveValue('');
    await expect(dialog.getByLabel('Description')).toHaveValue('');
    await expect(dialog.getByLabel('Priority')).toHaveValue('medium');
    await expect(dialog.getByLabel('Assignee')).toHaveValue('2');

    // Change assignee to Charlie, then mutate UserContext selection to Alice while dialog is open.
    await dialog.getByLabel('Assignee').selectOption('3');
    await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('#user-select')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, '1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('.current-user strong')).toHaveText('Alice');
    await expect(dialog.locator('.creating-as')).toHaveText('Creating as Bob');
    await expect(dialog.getByLabel('Assignee')).toHaveValue('3');

    const title = `Bob task ${randomUUID()}`;
    await dialog.getByLabel('Title').fill(title);
    const postPromise = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
    const postResponse = await postPromise;
    expect(postResponse.status()).toBe(201);
    const submittedBody = JSON.parse(postResponse.request().postData() ?? '{}');
    expect('description' in submittedBody).toBe(false);
    const created = assertTask(await postResponse.json());
    expect(created).toMatchObject({
      title,
      description: null,
      status: 'todo',
      priority: 'medium',
      assigned_to: 3,
      created_by: 2,
    });

    await expect(page.locator(`.task-card[data-task-id="${created.id}"] .task-description`)).toHaveCount(0);
    await expectBoard(page, await getTasks(request, fixtureURL), users);

    // Reopening now uses the then-current selected user (Alice).
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    await expect(dialog.locator('.creating-as')).toHaveText('Creating as Alice');
    await expect(dialog.getByLabel('Assignee')).toHaveValue('1');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  test('enforces client validation and 200/2000 Unicode code-point boundaries with zero invalid POSTs', async ({ page, request }) => {
    let postCount = 0;
    page.on('request', req => {
      if (req.url().endsWith('/api/tasks') && req.method() === 'POST') postCount++;
    });

    await page.goto(fixtureURL);
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    const titleInput = dialog.getByLabel('Title');
    const descInput = dialog.getByLabel('Description');
    const submitBtn = dialog.getByRole('button', { name: 'Create Task', exact: true });

    // Empty title.
    await submitBtn.click();
    await expect(dialog.getByText('Title is required.')).toBeVisible();
    await expect(titleInput).toHaveAttribute('aria-invalid', 'true');
    await expect(titleInput).toHaveAttribute('aria-describedby', 'task-title-error');
    await expect(titleInput).toBeFocused();
    expect(postCount).toBe(0);

    // Whitespace-only title.
    await titleInput.fill('   \t   ');
    await submitBtn.click();
    await expect(dialog.getByText('Title is required.')).toBeVisible();
    await expect(titleInput).toHaveAttribute('aria-invalid', 'true');
    await expect(titleInput).toBeFocused();
    expect(postCount).toBe(0);

    // 201 Unicode code-point title (multi-byte emoji).
    await titleInput.fill('😀'.repeat(201));
    await expect(dialog.getByText('Title must be 200 characters or fewer.')).toBeVisible();
    await expect(titleInput).toHaveAttribute('aria-invalid', 'true');
    await submitBtn.click();
    await expect(titleInput).toBeFocused();
    expect(postCount).toBe(0);

    // Valid title + 2,001 Unicode code-point description.
    const validUnicodeTitle = `U-${randomUUID().slice(0, 8)}-${'😀'.repeat(189)}`;
    expect(Array.from(validUnicodeTitle).length).toBe(200);
    await titleInput.fill(validUnicodeTitle);
    await expect(titleInput).toHaveAttribute('aria-invalid', 'false');

    await descInput.fill('é'.repeat(1000) + '🚀'.repeat(1001));
    await expect(dialog.getByText('Description must be 2,000 characters or fewer.')).toBeVisible();
    await expect(descInput).toHaveAttribute('aria-invalid', 'true');
    await expect(descInput).toHaveAttribute('aria-describedby', 'task-description-error');
    await submitBtn.click();
    await expect(descInput).toBeFocused();
    expect(postCount).toBe(0);

    // Exact 200 code-point title and 2,000 code-point description with preserved whitespace succeed.
    const validUnicodeDesc = `  ${'é'.repeat(998)}${'🚀'.repeat(998)}  `;
    expect(Array.from(validUnicodeDesc).length).toBe(2000);
    await descInput.fill(validUnicodeDesc);
    await expect(descInput).toHaveAttribute('aria-invalid', 'false');

    const postPromise = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'POST');
    await submitBtn.click();
    const postResponse = await postPromise;
    expect(postResponse.status()).toBe(201);
    expect(postCount).toBe(1);

    const created = assertTask(await postResponse.json());
    expect(Array.from(created.title).length).toBe(200);
    expect(created.title).toBe(validUnicodeTitle);
    expect(created.description).toBe(validUnicodeDesc);
    expect(Array.from(created.description ?? '').length).toBe(2000);

    const detail = await request.get(`${fixtureURL}/api/tasks/${created.id}`);
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toEqual(created);
  });

  test('rejects invalid API creation payloads and preserves task count', async ({ request }) => {
    const initialTasks = await getTasks(request, fixtureURL);
    const valid = { title: 'Valid task', priority: 'medium', assigned_to: 1, created_by: 1 };

    const invalidBodies: Array<{ label: string; body: string; contentType?: string; expectedStatus?: number; expectedField?: string }> = [
      { label: 'empty object', body: '{}' },
      { label: 'missing title', body: JSON.stringify({ priority: 'low', assigned_to: 1, created_by: 1 }), expectedField: 'title' },
      { label: 'missing priority', body: JSON.stringify({ title: 'T', assigned_to: 1, created_by: 1 }), expectedField: 'priority' },
      { label: 'missing assigned_to', body: JSON.stringify({ title: 'T', priority: 'low', created_by: 1 }), expectedField: 'assigned_to' },
      { label: 'missing created_by', body: JSON.stringify({ title: 'T', priority: 'low', assigned_to: 1 }), expectedField: 'created_by' },
      { label: 'whitespace title', body: JSON.stringify({ ...valid, title: '   \n\t  ' }), expectedField: 'title' },
      { label: '201-char ASCII title', body: JSON.stringify({ ...valid, title: 'a'.repeat(201) }), expectedField: 'title' },
      { label: '201-char pre-trim title', body: JSON.stringify({ ...valid, title: ` ${'a'.repeat(200)}` }), expectedField: 'title' },
      { label: '201-code-point Unicode title', body: JSON.stringify({ ...valid, title: '😀'.repeat(201) }), expectedField: 'title' },
      { label: '2001-char ASCII description', body: JSON.stringify({ ...valid, description: 'd'.repeat(2001) }), expectedField: 'description' },
      { label: '2001-code-point Unicode description', body: JSON.stringify({ ...valid, description: '🚀'.repeat(2001) }), expectedField: 'description' },
      { label: 'explicit null description', body: JSON.stringify({ ...valid, description: null }), expectedField: 'description' },
      { label: 'numeric description', body: JSON.stringify({ ...valid, description: 42 }), expectedField: 'description' },
      { label: 'null title', body: JSON.stringify({ ...valid, title: null }), expectedField: 'title' },
      { label: 'invalid priority enum', body: JSON.stringify({ ...valid, priority: 'urgent' }), expectedField: 'priority' },
      { label: 'uppercase priority enum', body: JSON.stringify({ ...valid, priority: 'HIGH' }), expectedField: 'priority' },
      { label: 'nonexistent assigned_to', body: JSON.stringify({ ...valid, assigned_to: 9999 }), expectedField: 'assigned_to' },
      { label: 'nonexistent created_by', body: JSON.stringify({ ...valid, created_by: 9999 }), expectedField: 'created_by' },
      { label: 'zero assigned_to', body: JSON.stringify({ ...valid, assigned_to: 0 }), expectedField: 'assigned_to' },
      { label: 'negative assigned_to', body: JSON.stringify({ ...valid, assigned_to: -1 }), expectedField: 'assigned_to' },
      { label: 'fractional assigned_to', body: '{"title":"T","priority":"low","assigned_to":1.5,"created_by":1}', expectedField: 'assigned_to' },
      { label: 'decimal .0 assigned_to', body: '{"title":"T","priority":"low","assigned_to":1.0,"created_by":1}', expectedField: 'assigned_to' },
      { label: 'exponent assigned_to', body: '{"title":"T","priority":"low","assigned_to":1e1,"created_by":1}', expectedField: 'assigned_to' },
      { label: 'overflow assigned_to', body: '{"title":"T","priority":"low","assigned_to":2147483648,"created_by":1}', expectedField: 'assigned_to' },
      { label: 'huge overflow created_by', body: '{"title":"T","priority":"low","assigned_to":1,"created_by":999999999999999999999}', expectedField: 'created_by' },
      { label: 'null created_by', body: JSON.stringify({ ...valid, created_by: null }), expectedField: 'created_by' },
      { label: 'string assigned_to', body: JSON.stringify({ ...valid, assigned_to: '1' }), expectedField: 'assigned_to' },
      { label: 'supplied status', body: JSON.stringify({ ...valid, status: 'done' }), expectedField: 'status' },
      { label: 'supplied id', body: JSON.stringify({ ...valid, id: 100 }), expectedField: 'id' },
      { label: 'supplied created_at', body: JSON.stringify({ ...valid, created_at: '2025-01-01T00:00:00Z' }), expectedField: 'created_at' },
      { label: 'supplied updated_at', body: JSON.stringify({ ...valid, updated_at: '2025-01-01T00:00:00Z' }), expectedField: 'updated_at' },
      { label: 'unknown field', body: JSON.stringify({ ...valid, extra: 'value' }), expectedField: 'extra' },
      { label: 'malformed JSON', body: '{"title":"unterminated' },
      { label: 'trailing JSON', body: `${JSON.stringify(valid)}{}` },
      { label: 'top-level array', body: '[]' },
      { label: 'top-level string', body: '"task"' },
      { label: 'top-level number', body: '42' },
      { label: 'top-level null', body: 'null' },
      { label: 'unsupported content type', body: JSON.stringify(valid), contentType: 'text/plain', expectedStatus: 415 },
      { label: 'oversized body', body: JSON.stringify({ ...valid, description: 'x'.repeat(70_000) }), expectedStatus: 413 },
    ];

    for (const tc of invalidBodies) {
      const response = await request.fetch(`${fixtureURL}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': tc.contentType ?? 'application/json' },
        data: tc.body,
      });
      expect(response.status(), tc.label).toBe(tc.expectedStatus ?? 400);
      expect(response.headers()['content-type'], tc.label).toContain('application/json');
      const errJson = await response.json();
      expect(typeof errJson.error, tc.label).toBe('string');
      expect(typeof errJson.message, tc.label).toBe('string');
      if (tc.expectedField) {
        expect(typeof errJson.fields?.[tc.expectedField], tc.label).toBe('string');
      }
    }

    expect(await getTasks(request, fixtureURL)).toEqual(initialTasks);

    // Explicit empty-string description is stored as empty string (distinct from omitted NULL).
    const emptyDescRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: { ...valid, title: `Empty desc ${randomUUID()}`, description: '' },
    });
    expect(emptyDescRes.status()).toBe(201);
    const emptyDescTask = assertTask(await emptyDescRes.json());
    expect(emptyDescTask.description).toBe('');
  });

  test('delayed real POST shows loading state, blocks duplicate submit and Escape dismissal, and concurrent API POSTs persist distinct IDs', async ({ page, request }) => {
    await page.goto(fixtureURL);
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    const delayedTitle = `Delayed task ${randomUUID()}`;
    await dialog.getByLabel('Title').fill(delayedTitle);

    let releasePost!: () => void;
    const postGate = new Promise<void>(resolve => { releasePost = resolve; });
    let postRequests = 0;

    await page.route('**/api/tasks', async route => {
      if (route.request().method() === 'POST') {
        postRequests++;
        await postGate;
      }
      await route.continue();
    });

    try {
      await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Creating…', exact: true })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      await expect(dialog.getByLabel('Title')).toBeDisabled();
      await expect(dialog.getByLabel('Description')).toBeDisabled();
      await expect(dialog.getByLabel('Priority')).toBeDisabled();
      await expect(dialog.getByLabel('Assignee')).toBeDisabled();

      // Attempt duplicate submission and Escape dismissal while pending.
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      expect(postRequests).toBe(1);
    } finally {
      releasePost();
    }

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Task created successfully.');
    await page.unroute('**/api/tasks');
    expect(sql(`SELECT count(*) FROM tasks WHERE title = '${delayedTitle}'`)).toBe('1');

    // Concurrent valid API POST requests produce distinct IDs and preserve sub-millisecond ordering.
    const batchTitles = Array.from({ length: 5 }, (_, i) => `Concurrent ${i} ${randomUUID()}`);
    const responses = await Promise.all(
      batchTitles.map((title, i) =>
        request.post(`${fixtureURL}/api/tasks`, {
          data: {
            title,
            description: `Concurrent item ${i}`,
            priority: (['low', 'medium', 'high'] as const)[i % 3],
            assigned_to: (i % 3) + 1,
            created_by: ((i + 1) % 3) + 1,
          },
        })
      )
    );
    const createdIds = new Set<number>();
    for (const res of responses) {
      expect(res.status()).toBe(201);
      const task = assertTask(await res.json());
      createdIds.add(task.id);
    }
    expect(createdIds.size).toBe(batchTitles.length);
    const allTasks = assertTasks(await (await request.get(`${fixtureURL}/api/tasks`)).json());
    for (const id of createdIds) {
      expect(allTasks.some(t => t.id === id)).toBe(true);
    }
  });

  test('supports autofocus, keyboard navigation, Escape/Cancel without writes, focus restoration and narrow viewport', async ({ page }) => {
    let postCount = 0;
    page.on('request', req => {
      if (req.url().endsWith('/api/tasks') && req.method() === 'POST') postCount++;
    });

    await page.goto(fixtureURL);
    const trigger = page.getByRole('button', { name: 'Create Task', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Title')).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Description')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Priority')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Assignee')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Create Task', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();

    // Escape closes without writes and restores focus to trigger.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(postCount).toBe(0);

    // Reopen, enter text, Cancel without writes and restore focus.
    await trigger.click();
    await dialog.getByLabel('Title').fill('Discard me');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(postCount).toBe(0);

    // Narrow mobile viewport (320x700) layout check.
    await page.setViewportSize({ width: 320, height: 700 });
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Title')).toBeVisible();
    await expect(dialog.getByLabel('Description')).toBeVisible();
    await expect(dialog.getByLabel('Priority')).toBeVisible();
    await expect(dialog.getByLabel('Assignee')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create Task', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  // Narrow failure-state interception exception: exercises definite rejection retry, uncertain connection loss,
  // failed post-save board GET, and post-save GET superseding an in-flight refresh.
  test('handles definite rejection retry, uncertain network outcome without auto-retry, and post-save refresh failure or superseding', async ({ page }) => {
    await page.goto(fixtureURL);

    // 1. Definite 500 rejection preserves form data and allows deliberate retry.
    let failPost = true;
    await page.route('**/api/tasks', async route => {
      if (route.request().method() === 'POST' && failPost) {
        failPost = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'internal_error', message: 'unable to create task' }),
        });
        return;
      }
      await route.continue();
    });

    const retryTitle = `Retry task ${randomUUID()}`;
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    await dialog.getByLabel('Title').fill(retryTitle);
    await dialog.getByLabel('Description').fill('Preserved description');
    await dialog.getByLabel('Priority').selectOption('high');
    await dialog.getByLabel('Assignee').selectOption('2');
    await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();

    await expect(dialog.getByRole('alert')).toContainText('unable to create task');
    await expect(dialog.getByLabel('Title')).toHaveValue(retryTitle);
    await expect(dialog.getByLabel('Description')).toHaveValue('Preserved description');
    await expect(dialog.getByLabel('Priority')).toHaveValue('high');
    await expect(dialog.getByLabel('Assignee')).toHaveValue('2');

    // Deliberate retry succeeds against real backend.
    await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: retryTitle, exact: true })).toBeVisible();
    await page.unroute('**/api/tasks');

    // 2. Uncertain network outcome preserves data, never auto-retries POST, and offers nonmutating board check.
    let uncertainPosts = 0;
    let uncertainGets = 0;
    await page.route('**/api/tasks', async route => {
      if (route.request().method() === 'POST') {
        uncertainPosts++;
        await route.abort('connectionreset');
        return;
      }
      uncertainGets++;
      await route.continue();
    });

    const uncertainTitle = `Uncertain task ${randomUUID()}`;
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    await dialog.getByLabel('Title').fill(uncertainTitle);
    await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();

    await expect(dialog.getByRole('alert')).toContainText(/check the board before submitting again/i);
    await expect(dialog.getByLabel('Title')).toHaveValue(uncertainTitle);
    expect(uncertainPosts).toBe(1);

    await dialog.getByRole('button', { name: 'Check board', exact: true }).click();
    await expect(dialog.getByText(/Board refreshed/i)).toBeVisible();
    expect(uncertainPosts).toBe(1);
    expect(uncertainGets).toBe(1);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.unroute('**/api/tasks');

    // 3. Confirmed 201 followed by failed post-save GET keeps dialog closed and offers GET-only retry.
    let failNextGet = false;
    let postSavePosts = 0;
    await page.route('**/api/tasks', async route => {
      if (route.request().method() === 'POST') {
        postSavePosts++;
        failNextGet = true;
        await route.continue();
        return;
      }
      if (failNextGet) {
        failNextGet = false;
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    const staleRefreshTitle = `Saved stale ${randomUUID()}`;
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    await dialog.getByLabel('Title').fill(staleRefreshTitle);
    await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText('Task saved, but the board could not be refreshed');
    expect(postSavePosts).toBe(1);

    await page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: staleRefreshTitle, exact: true })).toBeVisible();
    expect(postSavePosts).toBe(1);
    await page.unroute('**/api/tasks');

    // 4. Guaranteed post-save refresh when a preexisting manual refresh is in flight.
    let releaseStaleGet!: () => void;
    const staleGetGate = new Promise<void>(resolve => { releaseStaleGet = resolve; });
    let holdFirstGet = true;
    await page.route('**/api/tasks', async route => {
      if (route.request().method() === 'GET' && holdFirstGet) {
        holdFirstGet = false;
        await staleGetGate;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const supersedeTitle = `Supersede ${randomUUID()}`;
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    await dialog.getByLabel('Title').fill(supersedeTitle);
    await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
    releaseStaleGet();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: supersedeTitle, exact: true })).toBeVisible();
    await page.unroute('**/api/tasks');
  });

  test('edits task details, reassigns across users, updates status from dialog and preserves creator across user switches', async ({ page, request }) => {
    const users = await getUsers(request, fixtureURL);
    await page.goto(fixtureURL);
    await expect(page.getByLabel('Current user')).toHaveValue('1');

    // Alice creates a task assigned to Alice.
    const initialTitle = `Editable task ${randomUUID()}`;
    const createRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: {
        title: initialTitle,
        description: 'Initial description notes',
        priority: 'low',
        assigned_to: 1,
        created_by: 1,
      },
    });
    expect(createRes.status()).toBe(201);
    const created = assertTask(await createRes.json());

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const beforeTasks = await getTasks(request, fixtureURL);
    const beforeTodoCount = beforeTasks.filter(t => t.status === 'todo').length;
    const beforeInProgressCount = beforeTasks.filter(t => t.status === 'in_progress').length;

    // Switch active user to Bob; Bob opens the task card body to edit and reassign to Charlie.
    await page.getByLabel('Current user').selectOption('2');
    const card = page.locator(`.task-card[data-task-id="${created.id}"]`);
    await card.locator('.task-card-body').click();

    const dialog = page.getByRole('dialog', { name: 'Task Details' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Task metadata')).toContainText('Created by: Alice');
    await expect(dialog.getByLabel('Title')).toHaveValue(initialTitle);
    await expect(dialog.getByLabel('Description')).toHaveValue('Initial description notes');
    await expect(dialog.getByLabel('Status')).toHaveValue('todo');
    await expect(dialog.getByLabel('Priority')).toHaveValue('low');
    await expect(dialog.getByLabel('Assignee')).toHaveValue('1');

    const updatedTitle = `Updated task ${randomUUID()}`;
    const updatedDesc = 'Updated multi-line\ndescription content';
    await dialog.getByLabel('Title').fill(`  ${updatedTitle}  `);
    await dialog.getByLabel('Description').fill(updatedDesc);
    await dialog.getByLabel('Status').selectOption('in_progress');
    await dialog.getByLabel('Priority').selectOption('high');
    await dialog.getByLabel('Assignee').selectOption('3');

    const putPromise = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${created.id}`) && r.request().method() === 'PUT');
    await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
    const putResponse = await putPromise;
    expect(putResponse.status()).toBe(200);
    const submittedBody = JSON.parse(putResponse.request().postData() ?? '{}');
    expect(Object.keys(submittedBody).sort()).toEqual(['assigned_to', 'description', 'priority', 'status', 'title']);

    const updated = assertTask(await putResponse.json());
    expect(updated).toMatchObject({
      id: created.id,
      title: updatedTitle,
      description: updatedDesc,
      status: 'in_progress',
      priority: 'high',
      assigned_to: 3,
      created_by: 1,
      created_at: created.created_at,
    });
    expect(Date.parse(updated.updated_at)).toBeGreaterThanOrEqual(Date.parse(created.updated_at));

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Task updated successfully.');
    await expect(page.getByRole('heading', { name: `To do (${beforeTodoCount - 1})`, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: `In progress (${beforeInProgressCount + 1})`, exact: true })).toBeVisible();

    const movedCard = page.getByRole('region', { name: `In progress (${beforeInProgressCount + 1})`, exact: true }).locator(`.task-card[data-task-id="${created.id}"]`);
    await expect(movedCard.getByRole('heading')).toHaveText(updatedTitle);
    await expect(movedCard).toContainText('Priority: high');
    await expect(movedCard).toContainText('Assigned to: Charlie');
    await expect(movedCard.locator('.task-description')).toHaveText(updatedDesc);
    await expect(movedCard.getByLabel('Status')).toHaveValue('in_progress');
    await expect(movedCard.locator('.task-card-trigger')).toBeFocused();

    // Verify direct SQL values, GET detail, GET list, manual Refresh and full page reload.
    const sqlRow = JSON.parse(sql(`SELECT row_to_json(t) FROM tasks t WHERE id = ${created.id}`));
    expect(sqlRow).toMatchObject({
      id: created.id,
      title: updatedTitle,
      description: updatedDesc,
      status: 'in_progress',
      priority: 'high',
      assigned_to: 3,
      created_by: 1,
    });

    const detailRes = await request.get(`${fixtureURL}/api/tasks/${created.id}`);
    expect(detailRes.status()).toBe(200);
    expect(await detailRes.json()).toEqual(updated);

    const afterTasks = await getTasks(request, fixtureURL);
    await expectBoard(page, afterTasks, users);

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expectBoard(page, afterTasks, users);

    await page.reload();
    await expectBoard(page, afterTasks, users);
    await expect(page.getByLabel('Current user')).toHaveValue('2');
  });

  test('quick status control moves tasks via pointer and keyboard without opening dialog and exercises all six transitions', async ({ page, request }) => {
    const users = await getUsers(request, fixtureURL);
    const createRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: {
        title: `Quick transition task ${randomUUID()}`,
        description: 'Quick control test description',
        priority: 'medium',
        assigned_to: 2,
        created_by: 1,
      },
    });
    expect(createRes.status()).toBe(201);
    const task = assertTask(await createRes.json());

    await page.goto(fixtureURL);
    const initialTasks = await getTasks(request, fixtureURL);
    await expectBoard(page, initialTasks, users);

    // 1. Pointer selection on card quick status control: todo -> in_progress.
    const card = page.locator(`.task-card[data-task-id="${task.id}"]`);
    const put1 = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${task.id}`) && r.request().method() === 'PUT');
    await card.getByLabel('Status').selectOption('in_progress');
    const res1 = await put1;
    expect(res1.status()).toBe(200);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(card.getByLabel('Status')).toHaveValue('in_progress');
    await expect(card.getByLabel('Status')).toBeFocused();

    // 2. Keyboard selection on card quick status control: in_progress -> done.
    const put2 = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${task.id}`) && r.request().method() === 'PUT');
    await card.getByLabel('Status').focus();
    await card.getByLabel('Status').selectOption('done');
    const res2 = await put2;
    expect(res2.status()).toBe(200);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(card.getByLabel('Status')).toHaveValue('done');
    expect(sql(`SELECT status FROM tasks WHERE id = ${task.id}`)).toBe('done');

    // 3. Exercise all six directed transitions plus unchanged status via real PUT API.
    const sequence: Array<['todo' | 'in_progress' | 'done', 'todo' | 'in_progress' | 'done']> = [
      ['done', 'todo'],
      ['todo', 'in_progress'],
      ['in_progress', 'done'],
      ['done', 'in_progress'],
      ['in_progress', 'todo'],
      ['todo', 'done'],
      ['done', 'done'],
    ];

    for (const [fromStatus, toStatus] of sequence) {
      expect(sql(`SELECT status FROM tasks WHERE id = ${task.id}`)).toBe(fromStatus);
      const putRes = await request.put(`${fixtureURL}/api/tasks/${task.id}`, {
        data: {
          title: task.title,
          description: task.description,
          status: toStatus,
          priority: task.priority,
          assigned_to: task.assigned_to,
        },
      });
      expect(putRes.status(), `${fromStatus} -> ${toStatus}`).toBe(200);
      const body = assertTask(await putRes.json());
      expect(body.status).toBe(toStatus);
      expect(body.created_by).toBe(task.created_by);
      expect(body.created_at).toBe(task.created_at);
      expect(sql(`SELECT status FROM tasks WHERE id = ${task.id}`)).toBe(toStatus);
    }

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expectBoard(page, await getTasks(request, fixtureURL), users);
  });

  test('enforces PUT validation, Unicode boundaries, immutable field rejection and 404/400 task ID contracts', async ({ page, request }) => {
    const createRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: {
        title: `Validation target ${randomUUID()}`,
        description: 'Original description',
        priority: 'medium',
        assigned_to: 1,
        created_by: 2,
      },
    });
    expect(createRes.status()).toBe(201);
    const target = assertTask(await createRes.json());
    const beforeSnapshot = sql(`SELECT row_to_json(t)::text FROM tasks t WHERE id = ${target.id}`);

    const baseValid = {
      title: target.title,
      description: target.description,
      status: target.status,
      priority: target.priority,
      assigned_to: target.assigned_to,
    };

    const invalidCases: Array<{ label: string; path?: string; body: string; contentType?: string; expectedStatus?: number; expectedField?: string }> = [
      { label: 'malformed ID alpha', path: '/api/tasks/abc', body: JSON.stringify(baseValid), expectedStatus: 400 },
      { label: 'malformed ID zero', path: '/api/tasks/0', body: JSON.stringify(baseValid), expectedStatus: 400 },
      { label: 'malformed ID negative', path: '/api/tasks/-5', body: JSON.stringify(baseValid), expectedStatus: 400 },
      { label: 'malformed ID overflow', path: '/api/tasks/2147483648', body: JSON.stringify(baseValid), expectedStatus: 400 },
      { label: 'absent task ID', path: '/api/tasks/2147483647', body: JSON.stringify(baseValid), expectedStatus: 404 },
      { label: 'empty object', body: '{}' },
      { label: 'missing title', body: JSON.stringify({ status: 'todo', priority: 'low', assigned_to: 1 }), expectedField: 'title' },
      { label: 'missing status', body: JSON.stringify({ title: 'T', priority: 'low', assigned_to: 1 }), expectedField: 'status' },
      { label: 'missing priority', body: JSON.stringify({ title: 'T', status: 'todo', assigned_to: 1 }), expectedField: 'priority' },
      { label: 'missing assigned_to', body: JSON.stringify({ title: 'T', status: 'todo', priority: 'low' }), expectedField: 'assigned_to' },
      { label: 'empty title', body: JSON.stringify({ ...baseValid, title: '' }), expectedField: 'title' },
      { label: 'whitespace title', body: JSON.stringify({ ...baseValid, title: '   \t\n ' }), expectedField: 'title' },
      { label: '201-char ASCII title', body: JSON.stringify({ ...baseValid, title: 'a'.repeat(201) }), expectedField: 'title' },
      { label: '201-code-point Unicode title', body: JSON.stringify({ ...baseValid, title: '😀'.repeat(201) }), expectedField: 'title' },
      { label: '2001-code-point Unicode description', body: JSON.stringify({ ...baseValid, description: '🚀'.repeat(2001) }), expectedField: 'description' },
      { label: 'null description', body: JSON.stringify({ ...baseValid, description: null }), expectedField: 'description' },
      { label: 'numeric description', body: JSON.stringify({ ...baseValid, description: 123 }), expectedField: 'description' },
      { label: 'invalid status enum', body: JSON.stringify({ ...baseValid, status: 'blocked' }), expectedField: 'status' },
      { label: 'null status', body: JSON.stringify({ ...baseValid, status: null }), expectedField: 'status' },
      { label: 'invalid priority enum', body: JSON.stringify({ ...baseValid, priority: 'urgent' }), expectedField: 'priority' },
      { label: 'null priority', body: JSON.stringify({ ...baseValid, priority: null }), expectedField: 'priority' },
      { label: 'nonexistent assigned_to', body: JSON.stringify({ ...baseValid, assigned_to: 9999 }), expectedField: 'assigned_to' },
      { label: 'zero assigned_to', body: JSON.stringify({ ...baseValid, assigned_to: 0 }), expectedField: 'assigned_to' },
      { label: 'fractional assigned_to', body: '{"title":"T","status":"todo","priority":"low","assigned_to":1.5}', expectedField: 'assigned_to' },
      { label: 'string assigned_to', body: JSON.stringify({ ...baseValid, assigned_to: '1' }), expectedField: 'assigned_to' },
      { label: 'immutable id (matching)', body: JSON.stringify({ ...baseValid, id: target.id }), expectedField: 'id' },
      { label: 'immutable created_by (matching)', body: JSON.stringify({ ...baseValid, created_by: target.created_by }), expectedField: 'created_by' },
      { label: 'immutable created_at (matching)', body: JSON.stringify({ ...baseValid, created_at: target.created_at }), expectedField: 'created_at' },
      { label: 'immutable updated_at (matching)', body: JSON.stringify({ ...baseValid, updated_at: target.updated_at }), expectedField: 'updated_at' },
      { label: 'immutable seed_key', body: JSON.stringify({ ...baseValid, seed_key: 'recoverboard:slice2:01' }), expectedField: 'seed_key' },
      { label: 'unknown property', body: JSON.stringify({ ...baseValid, extra: true }), expectedField: 'extra' },
      { label: 'malformed JSON', body: '{"title":"unterminated' },
      { label: 'trailing JSON', body: `${JSON.stringify(baseValid)}{}` },
      { label: 'unsupported content type', body: JSON.stringify(baseValid), contentType: 'text/plain', expectedStatus: 415 },
      { label: 'oversized body', body: JSON.stringify({ ...baseValid, description: 'x'.repeat(70_000) }), expectedStatus: 413 },
    ];

    for (const tc of invalidCases) {
      const res = await request.fetch(`${fixtureURL}${tc.path ?? `/api/tasks/${target.id}`}`, {
        method: 'PUT',
        headers: { 'Content-Type': tc.contentType ?? 'application/json' },
        data: tc.body,
      });
      expect(res.status(), tc.label).toBe(tc.expectedStatus ?? 400);
      expect(res.headers()['content-type'], tc.label).toContain('application/json');
      const errBody = await res.json();
      expect(typeof errBody.error, tc.label).toBe('string');
      expect(typeof errBody.message, tc.label).toBe('string');
      if (tc.expectedField) {
        expect(typeof errBody.fields?.[tc.expectedField], tc.label).toBe('string');
      }
    }

    // Row including timestamps must be completely unchanged after all rejected updates.
    expect(sql(`SELECT row_to_json(t)::text FROM tasks t WHERE id = ${target.id}`)).toBe(beforeSnapshot);

    // Client-side validation in TaskDetailsDialog prevents invalid PUT requests.
    let putCount = 0;
    page.on('request', req => {
      if (req.url().includes('/api/tasks/') && req.method() === 'PUT') putCount++;
    });

    await page.goto(fixtureURL);
    const card = page.locator(`.task-card[data-task-id="${target.id}"]`);
    await card.locator('.task-card-trigger').click();
    const dialog = page.getByRole('dialog', { name: 'Task Details' });
    await expect(dialog).toBeVisible();

    const titleInput = dialog.getByLabel('Title');
    const descInput = dialog.getByLabel('Description');
    const saveBtn = dialog.getByRole('button', { name: 'Save Changes', exact: true });

    await titleInput.fill('   ');
    await saveBtn.click();
    await expect(dialog.getByText('Title is required.')).toBeVisible();
    await expect(titleInput).toHaveAttribute('aria-invalid', 'true');
    await expect(titleInput).toBeFocused();
    expect(putCount).toBe(0);

    await titleInput.fill('😀'.repeat(201));
    await expect(dialog.getByText('Title must be 200 characters or fewer.')).toBeVisible();
    await saveBtn.click();
    expect(putCount).toBe(0);

    const exact200Title = `E-${randomUUID().slice(0, 8)}-${'😀'.repeat(189)}`;
    const exact2000Desc = 'é'.repeat(1000) + '🚀'.repeat(1000);
    await titleInput.fill(exact200Title);
    await descInput.fill(exact2000Desc + 'x');
    await expect(dialog.getByText('Description must be 2,000 characters or fewer.')).toBeVisible();
    await saveBtn.click();
    expect(putCount).toBe(0);

    await descInput.fill(exact2000Desc);
    const putPromise = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${target.id}`) && r.request().method() === 'PUT');
    await saveBtn.click();
    expect((await putPromise).status()).toBe(200);
    expect(putCount).toBe(1);
  });

  test('handles disappeared task 404 on open and on save, plus Escape/Cancel and narrow mobile viewport', async ({ page, request }) => {
    const res1 = await request.post(`${fixtureURL}/api/tasks`, {
      data: { title: `Vanish before open ${randomUUID()}`, priority: 'low', assigned_to: 1, created_by: 1 },
    });
    const task1 = assertTask(await res1.json());

    const res2 = await request.post(`${fixtureURL}/api/tasks`, {
      data: { title: `Vanish before save ${randomUUID()}`, description: 'Keep my draft', priority: 'medium', assigned_to: 2, created_by: 1 },
    });
    const task2 = assertTask(await res2.json());

    await page.goto(fixtureURL);
    await expect(page.locator(`.task-card[data-task-id="${task1.id}"]`)).toBeVisible();
    await expect(page.locator(`.task-card[data-task-id="${task2.id}"]`)).toBeVisible();

    // 1. Delete task1 in fixture SQL after board load, then open details -> GET 404 handled cleanly.
    sql(`DELETE FROM tasks WHERE id = ${task1.id}`);
    await page.locator(`.task-card[data-task-id="${task1.id}"] .task-card-trigger`).click();
    const dialog = page.getByRole('dialog', { name: 'Task Details' });
    await expect(dialog.getByRole('alert')).toContainText(/no longer available/i);
    await dialog.getByRole('button', { name: 'Refresh board', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(`.task-card[data-task-id="${task1.id}"]`)).toHaveCount(0);

    // 2. Open task2, edit draft, then delete task2 in SQL before saving -> PUT 404 preserves draft for inspection.
    const card2Trigger = page.locator(`.task-card[data-task-id="${task2.id}"] .task-card-trigger`);
    await card2Trigger.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Title')).toBeFocused();

    // Cancel and Escape restore focus without writes.
    await dialog.getByLabel('Title').fill('Unsaved edit');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(card2Trigger).toBeFocused();
    await expect(page.locator(`.task-card[data-task-id="${task2.id}"]`).getByRole('heading')).toHaveText(task2.title);

    // Reopen on narrow mobile viewport (320x700), verify no horizontal overflow, then trigger PUT 404.
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await card2Trigger.click();
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

    const importantDraft = `Preserved draft ${randomUUID()}`;
    await dialog.getByLabel('Title').fill(importantDraft);
    sql(`DELETE FROM tasks WHERE id = ${task2.id}`);
    await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();

    await expect(dialog.getByRole('alert')).toContainText(/no longer available/i);
    await expect(dialog.getByLabel('Title')).toHaveValue(importantDraft);
    await expect(dialog.getByRole('button', { name: 'Save Changes', exact: true })).toBeDisabled();

    await dialog.getByRole('button', { name: 'Refresh board', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(`.task-card[data-task-id="${task2.id}"]`)).toHaveCount(0);
  });

  // Narrow failure-state interception for PUT: exercises 500 rejection retry, pending duplicate block,
  // response-lost-after-write GET reconciliation, quick-status failure/retry, and stale GET vs PUT ordering.
  test('handles PUT failure retry, uncertain transport reconciliation, quick-status retry and stale GET protection', async ({ page, request }) => {
    const createRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: {
        title: `Resilience edit ${randomUUID()}`,
        description: 'Initial text',
        priority: 'low',
        assigned_to: 1,
        created_by: 1,
      },
    });
    const task = assertTask(await createRes.json());

    await page.goto(fixtureURL);
    const card = page.locator(`.task-card[data-task-id="${task.id}"]`);

    // 1. Delayed/failing PUT blocks duplicate submissions and Escape, preserves draft on 500, and succeeds on retry.
    let failPutOnce = true;
    let releasePut!: () => void;
    const putGate = new Promise<void>(resolve => { releasePut = resolve; });
    let putAttempts = 0;

    await page.route(`**/api/tasks/${task.id}`, async route => {
      if (route.request().method() === 'PUT') {
        putAttempts++;
        if (failPutOnce) {
          failPutOnce = false;
          await putGate;
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'internal_error', message: 'unable to update task' }),
          });
          return;
        }
      }
      await route.continue();
    });

    await card.locator('.task-card-trigger').click();
    const dialog = page.getByRole('dialog', { name: 'Task Details' });
    const editedTitle = `Saved after retry ${randomUUID()}`;
    await dialog.getByLabel('Title').fill(editedTitle);

    try {
      await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      expect(putAttempts).toBe(1);
    } finally {
      releasePut();
    }

    await expect(dialog.getByRole('alert')).toContainText('unable to update task');
    await expect(dialog.getByLabel('Title')).toHaveValue(editedTitle);
    await expect(card.getByRole('heading')).toHaveText(task.title);

    await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByRole('heading')).toHaveText(editedTitle);
    await page.unroute(`**/api/tasks/${task.id}`);

    // 2. Response lost after write: backend commits PUT, response aborts -> no auto-retry, GET reconciliation preserves draft until chosen.
    let lostPuts = 0;
    await page.route(`**/api/tasks/${task.id}`, async route => {
      if (route.request().method() === 'PUT') {
        lostPuts++;
        await route.fetch();
        await route.abort('connectionreset');
        return;
      }
      await route.continue();
    });

    await card.locator('.task-card-trigger').click();
    await expect(dialog).toBeVisible();
    const reconciledTitle = `Committed before drop ${randomUUID()}`;
    await dialog.getByLabel('Title').fill(reconciledTitle);
    await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();

    await expect(dialog.getByRole('alert')).toContainText(/could not confirm whether your changes were saved/i);
    expect(lostPuts).toBe(1);

    // Modify local draft slightly to verify Check latest task does not clobber draft until Reload latest task is clicked.
    await dialog.getByLabel('Title').fill(`${reconciledTitle} (local draft)`);
    await dialog.getByRole('button', { name: 'Check latest task', exact: true }).click();
    await expect(dialog.getByText(/Latest task state checked/i)).toBeVisible();
    await expect(dialog.getByLabel('Title')).toHaveValue(`${reconciledTitle} (local draft)`);
    expect(lostPuts).toBe(1);

    await dialog.getByRole('button', { name: 'Reload latest task', exact: true }).click();
    await expect(dialog.getByLabel('Title')).toHaveValue(reconciledTitle);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card.getByRole('heading')).toHaveText(reconciledTitle);
    await page.unroute(`**/api/tasks/${task.id}`);

    // 3. Quick status control failure retains old column/value and succeeds on explicit retry; stale GET never overwrites PUT.
    let failQuickOnce = true;
    await page.route(`**/api/tasks/${task.id}`, async route => {
      if (route.request().method() === 'PUT' && failQuickOnce) {
        failQuickOnce = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'internal_error', message: 'unable to update task' }),
        });
        return;
      }
      await route.continue();
    });

    await card.getByLabel('Status').selectOption('done');
    await expect(card.getByRole('alert')).toContainText('unable to update task');
    await expect(card.getByLabel('Status')).toHaveValue('todo');

    // Start a slow refresh GET before retrying quick status PUT, then release the stale GET after PUT completes.
    let releaseSlowGet!: () => void;
    const slowGetGate = new Promise<void>(resolve => { releaseSlowGet = resolve; });
    let delayFirstGet = true;
    await page.route('**/api/tasks', async route => {
      if (route.request().method() === 'GET' && delayFirstGet) {
        delayFirstGet = false;
        await slowGetGate;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const quickRetryPut = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${task.id}`) && r.request().method() === 'PUT');
    await card.getByRole('button', { name: 'Retry status update', exact: true }).click();
    expect((await quickRetryPut).status()).toBe(200);
    releaseSlowGet();

    await expect(page.locator(`.task-card[data-task-id="${task.id}"]`).getByLabel('Status')).toHaveValue('done');
    await page.unroute(`**/api/tasks/${task.id}`);
    await page.unroute('**/api/tasks');
  });

  test('deletes tasks across all statuses via confirmation dialog, preserves user selection, and transitions to empty column and empty board states', async ({ page, request }) => {
    const users = await getUsers(request, fixtureURL);

    // Create three tasks and place them in todo, in_progress, and done.
    const todoTitle = `Delete todo ${randomUUID()}`;
    const inProgressTitle = `Delete in_progress ${randomUUID()}`;
    const doneTitle = `Delete done ${randomUUID()}`;

    const todoRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: { title: todoTitle, description: 'Todo item to delete', priority: 'high', assigned_to: 1, created_by: 1 },
    });
    const todoTask = assertTask(await todoRes.json());

    const inProgCreate = await request.post(`${fixtureURL}/api/tasks`, {
      data: { title: inProgressTitle, description: 'In-progress item to delete', priority: 'medium', assigned_to: 2, created_by: 1 },
    });
    const inProgCreated = assertTask(await inProgCreate.json());
    const inProgPut = await request.put(`${fixtureURL}/api/tasks/${inProgCreated.id}`, {
      data: { title: inProgressTitle, description: 'In-progress item to delete', status: 'in_progress', priority: 'medium', assigned_to: 2 },
    });
    const inProgTask = assertTask(await inProgPut.json());

    const doneCreate = await request.post(`${fixtureURL}/api/tasks`, {
      data: { title: doneTitle, description: 'Done item to delete', priority: 'low', assigned_to: 3, created_by: 2 },
    });
    const doneCreated = assertTask(await doneCreate.json());
    const donePut = await request.put(`${fixtureURL}/api/tasks/${doneCreated.id}`, {
      data: { title: doneTitle, description: 'Done item to delete', status: 'done', priority: 'low', assigned_to: 3 },
    });
    const doneTask = assertTask(await donePut.json());

    const beforeTasks = await getTasks(request, fixtureURL);
    const beforeTodoCount = beforeTasks.filter(t => t.status === 'todo').length;
    const beforeInProgCount = beforeTasks.filter(t => t.status === 'in_progress').length;
    const beforeDoneCount = beforeTasks.filter(t => t.status === 'done').length;

    await page.goto(fixtureURL);
    await expectBoard(page, beforeTasks, users);

    // Select Bob (user 2) and verify deletion preserves user selection.
    await page.getByLabel('Current user').selectOption('2');
    await expect(page.getByLabel('Current user')).toHaveValue('2');

    let deleteRequests = 0;
    page.on('request', req => {
      if (req.method() === 'DELETE' && req.url().includes('/api/tasks/')) {
        deleteRequests++;
      }
    });

    // 1. Delete the todo task via Task Details -> Delete task -> Confirm Delete task.
    await page.locator(`.task-card[data-task-id="${todoTask.id}"] .task-card-trigger`).click();
    const dialog = page.getByRole('dialog', { name: 'Task Details' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Confirm task deletion', exact: true })).toBeVisible();
    await expect(dialog.getByText('Permanently delete this task? This cannot be undone.')).toBeVisible();
    await expect(dialog.locator('.delete-target-title')).toContainText(todoTitle);
    expect(deleteRequests).toBe(0);

    const deleteTodoPromise = page.waitForResponse(
      r => r.url().endsWith(`/api/tasks/${todoTask.id}`) && r.request().method() === 'DELETE',
    );
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    const deleteTodoRes = await deleteTodoPromise;
    expect(deleteTodoRes.status()).toBe(204);
    expect(deleteTodoRes.headers()['content-type']).toBeUndefined();
    expect(deleteRequests).toBe(1);

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Task deleted.');
    await expect(page.locator(`.task-card[data-task-id="${todoTask.id}"]`)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: `To do (${beforeTodoCount - 1})`, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: `In progress (${beforeInProgCount})`, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: `Done (${beforeDoneCount})`, exact: true })).toBeVisible();
    await expect(page.getByLabel('Current user')).toHaveValue('2');
    expect(await page.evaluate(() => localStorage.getItem('recoverboard.selectedUserId'))).toBe('2');

    // Verify SQL absence, GET detail 404, GET list omission, and page reload persistence.
    expect(sql(`SELECT count(*) FROM tasks WHERE id = ${todoTask.id}`)).toBe('0');
    expect((await request.get(`${fixtureURL}/api/tasks/${todoTask.id}`)).status()).toBe(404);
    const afterTodoTasks = await getTasks(request, fixtureURL);
    expect(afterTodoTasks.some(t => t.id === todoTask.id)).toBe(false);
    await expectBoard(page, afterTodoTasks, users);

    await page.reload();
    await expectBoard(page, afterTodoTasks, users);
    await expect(page.getByLabel('Current user')).toHaveValue('2');

    // 2. Delete the in_progress task and the done task.
    for (const [target, colLabel, expectedAfterCount] of [
      [inProgTask, 'In progress', beforeInProgCount - 1],
      [doneTask, 'Done', beforeDoneCount - 1],
    ] as const) {
      await page.locator(`.task-card[data-task-id="${target.id}"] .task-card-trigger`).click();
      await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
      const delPromise = page.waitForResponse(
        r => r.url().endsWith(`/api/tasks/${target.id}`) && r.request().method() === 'DELETE',
      );
      await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
      expect((await delPromise).status()).toBe(204);
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(`.task-card[data-task-id="${target.id}"]`)).toHaveCount(0);
      await expect(page.getByRole('heading', { name: `${colLabel} (${expectedAfterCount})`, exact: true })).toBeVisible();
      expect(sql(`SELECT count(*) FROM tasks WHERE id = ${target.id}`)).toBe('0');
    }

    // 3. Leave only one task on the entire board, then delete it via the UI to verify empty-column and empty-board states.
    const soleTask = (await getTasks(request, fixtureURL))[0];
    sql(`DELETE FROM tasks WHERE id <> ${soleTask.id}`);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.task-card')).toHaveCount(1);

    await page.locator(`.task-card[data-task-id="${soleTask.id}"] .task-card-trigger`).click();
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    const lastDelPromise = page.waitForResponse(
      r => r.url().endsWith(`/api/tasks/${soleTask.id}`) && r.request().method() === 'DELETE',
    );
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    expect((await lastDelPromise).status()).toBe(204);

    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.task-card')).toHaveCount(0);
    await expect(page.getByText('No tasks yet', { exact: true })).toBeVisible();
    await expect(page.getByText('No tasks in this column.', { exact: true })).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toBeFocused();
  });

  test('cancelling or pressing Escape in delete confirmation issues no DELETE, preserves unsaved editor draft and restores focus across desktop and mobile viewports', async ({ page, request }) => {
    const createRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: {
        title: `Cancel delete target ${randomUUID()}`,
        description: 'Persisted description',
        priority: 'low',
        assigned_to: 1,
        created_by: 1,
      },
    });
    const task = assertTask(await createRes.json());
    const beforeRow = sql(`SELECT row_to_json(t)::text FROM tasks t WHERE id = ${task.id}`);

    let mutationCount = 0;
    page.on('request', req => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method()) && req.url().includes('/api/tasks')) {
        mutationCount++;
      }
    });

    await page.goto(fixtureURL);
    const card = page.locator(`.task-card[data-task-id="${task.id}"]`);
    await card.locator('.task-card-trigger').click();
    const dialog = page.getByRole('dialog', { name: 'Task Details' });
    await expect(dialog).toBeVisible();

    // Edit all form fields without saving.
    const draftTitle = `Unsaved draft ${randomUUID()}`;
    const draftDesc = 'Unsaved draft description';
    await dialog.getByLabel('Title').fill(draftTitle);
    await dialog.getByLabel('Description').fill(draftDesc);
    await dialog.getByLabel('Status').selectOption('done');
    await dialog.getByLabel('Priority').selectOption('high');
    await dialog.getByLabel('Assignee').selectOption('3');

    // Open delete confirmation -> initial focus on Cancel, displays persisted title (not unsaved draft), no mutation sent.
    const deleteTrigger = dialog.getByRole('button', { name: 'Delete task', exact: true });
    await deleteTrigger.click();
    const cancelBtn = dialog.getByRole('button', { name: 'Cancel', exact: true });
    const confirmDeleteBtn = dialog.getByRole('button', { name: 'Delete task', exact: true });
    await expect(cancelBtn).toBeFocused();
    await expect(dialog.locator('.delete-target-title')).toContainText(task.title);
    await expect(dialog.getByText('Permanently delete this task? This cannot be undone.')).toBeVisible();
    expect(mutationCount).toBe(0);

    // Keyboard Tab / Shift+Tab navigation inside confirmation.
    await page.keyboard.press('Tab');
    await expect(confirmDeleteBtn).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(cancelBtn).toBeFocused();

    // Escape exits confirmation back to the editor (without closing the editor), restores focus to Delete task trigger, and keeps unsaved draft intact.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Confirm task deletion' })).toHaveCount(0);
    await expect(deleteTrigger).toBeFocused();
    await expect(dialog.getByLabel('Title')).toHaveValue(draftTitle);
    await expect(dialog.getByLabel('Description')).toHaveValue(draftDesc);
    await expect(dialog.getByLabel('Status')).toHaveValue('done');
    await expect(dialog.getByLabel('Priority')).toHaveValue('high');
    await expect(dialog.getByLabel('Assignee')).toHaveValue('3');
    expect(mutationCount).toBe(0);

    // Reopen confirmation via keyboard Enter on Delete task, verify narrow mobile viewport (320x700), then click Cancel.
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.keyboard.press('Enter');
    await expect(cancelBtn).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

    await cancelBtn.click();
    await expect(deleteTrigger).toBeFocused();
    await expect(dialog.getByLabel('Title')).toHaveValue(draftTitle);
    expect(mutationCount).toBe(0);

    // Escape in editor closes the dialog and restores focus to the card trigger; DB row is untouched.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(card.locator('.task-card-trigger')).toBeFocused();
    expect(sql(`SELECT row_to_json(t)::text FROM tasks t WHERE id = ${task.id}`)).toBe(beforeRow);
  });

  test('enforces DELETE API contract, concurrent delete atomicity, and UI reconciliation when confirming an already-deleted task', async ({ page, request }) => {
    const usersSnapshot = sql('SELECT json_agg(u ORDER BY id)::text FROM users u');
    const unrelatedRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: { title: `Unrelated surviving ${randomUUID()}`, priority: 'medium', assigned_to: 1, created_by: 1 },
    });
    const unrelatedTask = assertTask(await unrelatedRes.json());
    const unrelatedRow = sql(`SELECT row_to_json(t)::text FROM tasks t WHERE id = ${unrelatedTask.id}`);

    // 1. Invalid IDs return 400 JSON; nonexistent ID returns 404 JSON.
    for (const badId of ['abc', '+1', '-1', '0', '1.0', '1e1', '2147483648', '999999999999999999999']) {
      const res = await request.delete(`${fixtureURL}/api/tasks/${badId}`);
      expect(res.status(), badId).toBe(400);
      expect(res.headers()['content-type']).toContain('application/json');
      const body = await res.json();
      expect(body.error).toBe('invalid_task_id');
    }
    const missingRes = await request.delete(`${fixtureURL}/api/tasks/2147483647`);
    expect(missingRes.status()).toBe(404);
    expect((await missingRes.json()).error).toBe('not_found');

    // 2. Concurrent DELETE requests on the same task produce exactly one 204 and 404 for the rest.
    const concurrentTargetRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: { title: `Concurrent delete ${randomUUID()}`, priority: 'high', assigned_to: 2, created_by: 1 },
    });
    const concurrentTarget = assertTask(await concurrentTargetRes.json());

    const concurrentResults = await Promise.all(
      Array.from({ length: 5 }, () => request.delete(`${fixtureURL}/api/tasks/${concurrentTarget.id}`)),
    );
    const statuses = concurrentResults.map(r => r.status()).sort();
    expect(statuses).toEqual([204, 404, 404, 404, 404]);
    expect(sql(`SELECT count(*) FROM tasks WHERE id = ${concurrentTarget.id}`)).toBe('0');

    // Users and unrelated task remain completely untouched.
    expect(sql('SELECT json_agg(u ORDER BY id)::text FROM users u')).toBe(usersSnapshot);
    expect(sql(`SELECT row_to_json(t)::text FROM tasks t WHERE id = ${unrelatedTask.id}`)).toBe(unrelatedRow);

    // 3. Already-deleted task in UI: another client deletes the task while confirmation is open -> confirming gets 404, reconciles stale UI, and does not claim this request deleted it.
    const staleUiRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: { title: `Already gone ${randomUUID()}`, priority: 'low', assigned_to: 3, created_by: 2 },
    });
    const staleUiTask = assertTask(await staleUiRes.json());

    await page.goto(fixtureURL);
    const staleCard = page.locator(`.task-card[data-task-id="${staleUiTask.id}"]`);
    await expect(staleCard).toBeVisible();

    await staleCard.locator('.task-card-trigger').click();
    const dialog = page.getByRole('dialog', { name: 'Task Details' });
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Confirm task deletion' })).toBeVisible();

    // Concurrent API DELETE removes the task before the user confirms in the modal.
    const externalDelete = await request.delete(`${fixtureURL}/api/tasks/${staleUiTask.id}`);
    expect(externalDelete.status()).toBe(204);
    expect((await externalDelete.body()).length).toBe(0);
    expect(await externalDelete.text()).toBe('');

    const uiDeletePromise = page.waitForResponse(
      r => r.url().endsWith(`/api/tasks/${staleUiTask.id}`) && r.request().method() === 'DELETE',
    );
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    expect((await uiDeletePromise).status()).toBe(404);

    await expect(dialog).toHaveCount(0);
    await expect(staleCard).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Task no longer exists on the server; board updated.');
  });

  // Combines real database trigger failure (500) on the exclusive fixture with narrow transport/refresh resilience checks.
  test('handles real database 500 failure and retry on DELETE, pending duplicate guard, uncertain transport reconciliation, post-delete refresh failure and stale GET protection', async ({ page, request }) => {
    const createRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: {
        title: `Delete resilience ${randomUUID()}`,
        description: 'Resilience test task',
        priority: 'high',
        assigned_to: 1,
        created_by: 1,
      },
    });
    const task = assertTask(await createRes.json());

    await page.goto(fixtureURL);
    const card = page.locator(`.task-card[data-task-id="${task.id}"]`);
    await card.locator('.task-card-trigger').click();
    const dialog = page.getByRole('dialog', { name: 'Task Details' });
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();

    // 1. Induce a real PostgreSQL failure on DELETE using a temporary BEFORE DELETE trigger on the isolated fixture.
    sql(`
      CREATE OR REPLACE FUNCTION fail_task_delete() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'simulated database delete failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_task_delete BEFORE DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION fail_task_delete();
    `);
    try {
      const failedDelPromise = page.waitForResponse(
        r => r.url().endsWith(`/api/tasks/${task.id}`) && r.request().method() === 'DELETE',
      );
      await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
      const failedDelRes = await failedDelPromise;
      expect(failedDelRes.status()).toBe(500);
      const errBody = await failedDelRes.json();
      expect(errBody).toEqual({ error: 'internal_error', message: 'unable to delete task' });

      await expect(dialog.getByRole('alert')).toContainText('unable to delete task');
      await expect(card).toBeVisible();
      expect(sql(`SELECT count(*) FROM tasks WHERE id = ${task.id}`)).toBe('1');
    } finally {
      sql('DROP TRIGGER IF EXISTS trg_fail_task_delete ON tasks; DROP FUNCTION IF EXISTS fail_task_delete();');
    }

    // 2. Pending state guard (Deleting…) blocks duplicate submit and Escape dismissal, then real retry succeeds once.
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve; });
    let deleteAttempts = 0;
    await page.route(`**/api/tasks/${task.id}`, async route => {
      if (route.request().method() === 'DELETE') {
        deleteAttempts++;
        await deleteGate;
      }
      await route.continue();
    });

    try {
      await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Deleting…', exact: true })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      expect(deleteAttempts).toBe(1);
    } finally {
      releaseDelete();
    }

    await expect(dialog).toHaveCount(0);
    await expect(card).toHaveCount(0);
    expect(sql(`SELECT count(*) FROM tasks WHERE id = ${task.id}`)).toBe('0');
    await page.unroute(`**/api/tasks/${task.id}`);

    // 3. Uncertain transport outcome on DELETE:
    // (a) Aborted before server delete -> Check latest task sees 200 OK and informs user task still exists.
    // (b) Response lost after server delete commits -> Check latest task sees 404 and reconciles without re-deleting.
    const uncertainTaskRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: { title: `Uncertain delete ${randomUUID()}`, priority: 'medium', assigned_to: 2, created_by: 1 },
    });
    const uncertainTask = assertTask(await uncertainTaskRes.json());
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();

    let abortBeforeWrite = true;
    let uncertainDeleteCalls = 0;
    await page.route(`**/api/tasks/${uncertainTask.id}`, async route => {
      if (route.request().method() === 'DELETE') {
        uncertainDeleteCalls++;
        if (abortBeforeWrite) {
          abortBeforeWrite = false;
          await route.abort('connectionreset');
          return;
        }
        await route.fetch();
        await route.abort('connectionreset');
        return;
      }
      await route.continue();
    });

    const uncertainCard = page.locator(`.task-card[data-task-id="${uncertainTask.id}"]`);
    await uncertainCard.locator('.task-card-trigger').click();
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();

    await expect(dialog.getByRole('alert')).toContainText(/could not confirm whether the task was deleted/i);
    expect(uncertainDeleteCalls).toBe(1);

    await dialog.getByRole('button', { name: 'Check latest task', exact: true }).click();
    await expect(dialog.getByText(/Task still exists on the server/i)).toBeVisible();
    expect(uncertainDeleteCalls).toBe(1);

    // Deliberate retry now commits on server before connection drops; Check latest task sees 404 and closes/reconciles.
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    expect(uncertainDeleteCalls).toBe(2);
    await dialog.getByRole('button', { name: 'Check latest task', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(uncertainCard).toHaveCount(0);
    expect(uncertainDeleteCalls).toBe(2);
    await page.unroute(`**/api/tasks/${uncertainTask.id}`);

    // 4. Confirmed 204 followed by failed post-delete board GET keeps task removed locally and offers GET-only Retry refresh,
    // and stale pre-existing GET never reinserts a deleted card.
    const raceTaskRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: { title: `Refresh race delete ${randomUUID()}`, priority: 'low', assigned_to: 1, created_by: 1 },
    });
    const raceTask = assertTask(await raceTaskRes.json());
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const raceCard = page.locator(`.task-card[data-task-id="${raceTask.id}"]`);
    await expect(raceCard).toBeVisible();

    let releaseStaleGet!: () => void;
    const staleGetGate = new Promise<void>(resolve => { releaseStaleGet = resolve; });
    let holdFirstGet = true;
    let failSecondGet = false;

    await page.route('**/api/tasks', async route => {
      if (route.request().method() === 'GET') {
        if (holdFirstGet) {
          holdFirstGet = false;
          await staleGetGate;
          await route.continue();
          return;
        }
        if (failSecondGet) {
          failSecondGet = false;
          await route.abort('failed');
          return;
        }
      }
      await route.continue();
    });

    // Start a slow manual Refresh GET before opening and deleting raceTask.
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await raceCard.locator('.task-card-trigger').click();
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    failSecondGet = true;
    await dialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    releaseStaleGet();

    await expect(dialog).toHaveCount(0);
    await expect(raceCard).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText('Task deleted, but the board could not be refreshed');

    await page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(raceCard).toHaveCount(0);
    await page.unroute('**/api/tasks');
  });

  test('filters tasks by assignee, status, priority, combined AND criteria, column counts, empty results and Clear Filters without extra network requests', async ({ page, request }) => {
    const users = await getUsers(request, fixtureURL);

    // Create identifiable tasks with known combinations on top of the seeded baseline.
    const customSpecs = [
      { title: `Filter Bob InProgress High ${randomUUID()}`, status: 'in_progress', priority: 'high', assigned_to: 2, created_by: 1 },
      { title: `Filter Alice Todo Low ${randomUUID()}`, status: 'todo', priority: 'low', assigned_to: 1, created_by: 2 },
      { title: `Filter Charlie Done Medium ${randomUUID()}`, status: 'done', priority: 'medium', assigned_to: 3, created_by: 3 },
    ] as const;

    for (const spec of customSpecs) {
      const createRes = await request.post(`${fixtureURL}/api/tasks`, {
        data: {
          title: spec.title,
          description: `Created for filter test (${spec.status}/${spec.priority})`,
          priority: spec.priority,
          assigned_to: spec.assigned_to,
          created_by: spec.created_by,
        },
      });
      expect(createRes.status()).toBe(201);
      const created = assertTask(await createRes.json());
      if (spec.status !== 'todo') {
        const updateRes = await request.put(`${fixtureURL}/api/tasks/${created.id}`, {
          data: {
            title: created.title,
            description: created.description ?? '',
            status: spec.status,
            priority: created.priority,
            assigned_to: created.assigned_to,
          },
        });
        expect(updateRes.status()).toBe(200);
      }
    }

    const allTasks = await getTasks(request, fixtureURL);
    let taskListRequests = 0;
    page.on('request', req => {
      if (req.url().endsWith('/api/tasks') && req.method() === 'GET') taskListRequests++;
    });

    await page.goto(fixtureURL);
    await expectBoard(page, allTasks, users);
    const baselineRequests = taskListRequests;

    const filterGroup = page.getByRole('group', { name: 'Task filters' });
    await expect(filterGroup).toBeVisible();
    const assigneeSelect = filterGroup.getByLabel('Assignee');
    const statusSelect = filterGroup.getByLabel('Status');
    const prioritySelect = filterGroup.getByLabel('Priority');
    const clearButton = filterGroup.getByRole('button', { name: 'Clear Filters', exact: true });

    // Integration Test 1: Default filters, options, and disabled Clear Filters.
    await expect(assigneeSelect).toBeVisible();
    await expect(statusSelect).toBeVisible();
    await expect(prioritySelect).toBeVisible();
    await expect(clearButton).toBeVisible();
    await expect(clearButton).toBeDisabled();

    await expect(assigneeSelect).toHaveValue('');
    await expect(assigneeSelect.locator('option')).toHaveText(['All Users', ...users.map(u => u.name)]);
    await expect(statusSelect).toHaveValue('');
    await expect(statusSelect.locator('option')).toHaveText(['All Statuses', 'To Do', 'In Progress', 'Done']);
    await expect(prioritySelect).toHaveValue('');
    await expect(prioritySelect.locator('option')).toHaveText(['All Priorities', 'Low', 'Medium', 'High']);

    // Integration Test 2: Filter by Assignee (Bob -> Alice -> Charlie -> All Users).
    for (const user of users) {
      await assigneeSelect.selectOption(String(user.id));
      await expect(clearButton).toBeEnabled();
      await expectBoard(
        page,
        allTasks.filter(t => t.assigned_to === user.id),
        users,
        { filtered: true },
      );
    }
    await assigneeSelect.selectOption('');
    await expect(clearButton).toBeDisabled();
    await expectBoard(page, allTasks, users);

    // Integration Test 3: Filter by Status (In Progress, To Do, Done, All Statuses).
    for (const status of ['in_progress', 'todo', 'done'] as const) {
      await statusSelect.selectOption(status);
      await expect(clearButton).toBeEnabled();
      await expectBoard(
        page,
        allTasks.filter(t => t.status === status),
        users,
        { filtered: true },
      );
    }
    await statusSelect.selectOption('');
    await expect(clearButton).toBeDisabled();
    await expectBoard(page, allTasks, users);

    // Integration Test 4: Filter by Priority (High, Medium, Low, All Priorities).
    for (const priority of ['high', 'medium', 'low'] as const) {
      await prioritySelect.selectOption(priority);
      await expect(clearButton).toBeEnabled();
      await expectBoard(
        page,
        allTasks.filter(t => t.priority === priority),
        users,
        { filtered: true },
      );
    }
    await prioritySelect.selectOption('');
    await expect(clearButton).toBeDisabled();
    await expectBoard(page, allTasks, users);

    // Integration Test 5, 6, 7: Combined AND filters (Bob + In Progress + High) and Clear Filters.
    await assigneeSelect.selectOption('2');
    await statusSelect.selectOption('in_progress');
    await prioritySelect.selectOption('high');
    await expect(clearButton).toBeEnabled();

    const bobInProgressHigh = allTasks.filter(
      t => t.assigned_to === 2 && t.status === 'in_progress' && t.priority === 'high',
    );
    expect(bobInProgressHigh.length).toBeGreaterThan(0);
    await expectBoard(page, bobInProgressHigh, users, { filtered: true });

    // Clear Filters resets all three dropdowns, restores unfiltered board & counts, and issues zero GET requests.
    await clearButton.click();
    await expect(assigneeSelect).toHaveValue('');
    await expect(statusSelect).toHaveValue('');
    await expect(prioritySelect).toHaveValue('');
    await expect(clearButton).toBeDisabled();
    await expectBoard(page, allTasks, users);
    expect(taskListRequests).toBe(baselineRequests);

    // Integration Test 8: Empty filtered results vs unfiltered board.
    // Remove tasks matching (assigned_to=3 AND status='in_progress' AND priority='low') in SQL and refresh so that combination has 0 matches while board is non-empty.
    sql("DELETE FROM tasks WHERE assigned_to = 3 AND status = 'in_progress' AND priority = 'low';");
    const afterSqlTasks = await getTasks(request, fixtureURL);
    expect(afterSqlTasks.length).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expectBoard(page, afterSqlTasks, users);

    await assigneeSelect.selectOption('3');
    await statusSelect.selectOption('in_progress');
    await prioritySelect.selectOption('low');
    await expectBoard(page, [], users, { filtered: true });
    await expect(page.getByText('No tasks match the selected filters.', { exact: true })).toBeVisible();
    await expect(page.getByText('No matching tasks in this column.', { exact: true })).toHaveCount(3);
    await expect(page.getByText('No tasks yet', { exact: true })).toHaveCount(0);

    // Mobile responsive check (320x700) with active filters and empty filter message.
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await expect(assigneeSelect).toBeVisible();
    await expect(statusSelect).toBeVisible();
    await expect(prioritySelect).toBeVisible();
    await expect(clearButton).toBeVisible();

    await clearButton.click();
    await expectBoard(page, afterSqlTasks, users);
    await page.setViewportSize({ width: 1280, height: 720 });

    // Distinguish API error on initial load from empty filtered results, while preserving filter selections.
    let failInitialGet = true;
    await page.route('**/api/tasks', async route => {
      if (route.request().method() === 'GET' && failInitialGet) {
        failInitialGet = false;
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await page.reload();
    await expect(page.getByRole('alert')).toContainText('Tasks could not be loaded.');
    await expect(page.getByText('No tasks match the selected filters.')).toHaveCount(0);
    await assigneeSelect.selectOption('2');
    await prioritySelect.selectOption('high');
    await expect(assigneeSelect).toHaveValue('2');
    await expect(prioritySelect).toHaveValue('high');
    await expect(page.getByText('No tasks match the selected filters.')).toHaveCount(0);

    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(assigneeSelect).toHaveValue('2');
    await expect(prioritySelect).toHaveValue('high');
    await expectBoard(
      page,
      afterSqlTasks.filter(t => t.assigned_to === 2 && t.priority === 'high'),
      users,
      { filtered: true },
    );
    await page.unroute('**/api/tasks');
  });

  test('integrates filtering with task creation, detail editing, reassignment, dialog status changes and card quick-status transitions', async ({ page, request }) => {
    const users = await getUsers(request, fixtureURL);
    await page.goto(fixtureURL);

    const filterGroup = page.getByRole('group', { name: 'Task filters' });
    const assigneeSelect = filterGroup.getByLabel('Assignee');
    const statusSelect = filterGroup.getByLabel('Status');
    const prioritySelect = filterGroup.getByLabel('Priority');
    const clearButton = filterGroup.getByRole('button', { name: 'Clear Filters', exact: true });

    // Integration Test 9: Task Creation Under Filters.
    // Filter board to Charlie (id = 3).
    await assigneeSelect.selectOption('3');
    const beforeCharlieTasks = (await getTasks(request, fixtureURL)).filter(t => t.assigned_to === 3);
    await expectBoard(page, beforeCharlieTasks, users, { filtered: true });

    // 1. Create a matching task assigned to Charlie -> appears immediately under active filter.
    const charlieTitle = `Charlie filtered create ${randomUUID()}`;
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: 'Create Task' });
    await createDialog.getByLabel('Title').fill(charlieTitle);
    await createDialog.getByLabel('Priority').selectOption('high');
    await createDialog.getByLabel('Assignee').selectOption('3');
    await createDialog.getByRole('button', { name: 'Create Task', exact: true }).click();

    await expect(createDialog).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Task created successfully.');
    await expect(assigneeSelect).toHaveValue('3');
    await expect(page.getByRole('heading', { name: charlieTitle, exact: true })).toBeVisible();

    // 2. Create a non-matching task assigned to Bob -> succeeds, shows notice, keeps filter, stays hidden until cleared.
    const bobHiddenTitle = `Bob hidden create ${randomUUID()}`;
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    await createDialog.getByLabel('Title').fill(bobHiddenTitle);
    await createDialog.getByLabel('Priority').selectOption('high');
    await createDialog.getByLabel('Assignee').selectOption('2');
    await createDialog.getByRole('button', { name: 'Create Task', exact: true }).click();

    await expect(createDialog).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Task created successfully.');
    await expect(assigneeSelect).toHaveValue('3');
    await expect(page.getByRole('heading', { name: bobHiddenTitle, exact: true })).toHaveCount(0);

    // Clearing filters reveals Bob's newly created task.
    await clearButton.click();
    const tasksAfterCreates = await getTasks(request, fixtureURL);
    const bobCreatedTask = tasksAfterCreates.find(t => t.title === bobHiddenTitle)!;
    const charlieCreatedTask = tasksAfterCreates.find(t => t.title === charlieTitle)!;
    expect(bobCreatedTask).toBeDefined();
    expect(charlieCreatedTask).toBeDefined();
    await expect(page.getByRole('heading', { name: bobHiddenTitle, exact: true })).toBeVisible();
    await expectBoard(page, tasksAfterCreates, users);

    // Integration Test 10: Task Editing, Reassignment, and Status Changes Under Filters.
    // A. Filter by Priority = High; change bobCreatedTask from High to Low -> disappears from filtered view.
    await prioritySelect.selectOption('high');
    const bobCard = page.locator(`.task-card[data-task-id="${bobCreatedTask.id}"]`);
    await expect(bobCard).toBeVisible();
    await bobCard.locator('.task-card-trigger').click();

    const detailsDialog = page.getByRole('dialog', { name: 'Task Details' });
    await expect(detailsDialog).toBeVisible();
    await detailsDialog.getByLabel('Priority').selectOption('low');
    await detailsDialog.getByRole('button', { name: 'Save Changes', exact: true }).click();

    await expect(detailsDialog).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Task updated successfully.');
    await expect(bobCard).toHaveCount(0);

    // B. Filter by Assignee = Charlie (clear Priority first); reassign charlieCreatedTask to Alice -> disappears.
    await clearButton.click();
    await expect(bobCard).toBeVisible();
    await expect(bobCard).toContainText('Priority: low');

    await assigneeSelect.selectOption('3');
    const charlieCard = page.locator(`.task-card[data-task-id="${charlieCreatedTask.id}"]`);
    await expect(charlieCard).toBeVisible();
    await charlieCard.locator('.task-card-trigger').click();
    await expect(detailsDialog).toBeVisible();
    await detailsDialog.getByLabel('Assignee').selectOption('1');
    await detailsDialog.getByRole('button', { name: 'Save Changes', exact: true }).click();

    await expect(detailsDialog).toHaveCount(0);
    await expect(charlieCard).toHaveCount(0);

    // C. Filter by Status = To Do; move one task via dialog (todo -> in_progress) and another via quick-status select (todo -> done).
    await clearButton.click();
    await statusSelect.selectOption('todo');
    await expect(bobCard).toBeVisible();
    await expect(charlieCard).toBeVisible();

    // Dialog status change: bobCard todo -> in_progress removes it from To Do filtered view.
    await bobCard.locator('.task-card-trigger').click();
    await expect(detailsDialog).toBeVisible();
    await detailsDialog.getByLabel('Status').selectOption('in_progress');
    await detailsDialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect(detailsDialog).toHaveCount(0);
    await expect(bobCard).toHaveCount(0);

    // Quick-status change: charlieCard todo -> done removes it from To Do filtered view.
    await charlieCard.getByLabel('Status').selectOption('done');
    await expect(page.getByRole('status')).toHaveText('Task status updated.');
    await expect(charlieCard).toHaveCount(0);

    // Clearing filters reveals both updated tasks in their new status columns.
    await clearButton.click();
    const finalTasks = await getTasks(request, fixtureURL);
    await expectBoard(page, finalTasks, users);
    await expect(page.getByRole('region', { name: /^In progress / }).locator(`.task-card[data-task-id="${bobCreatedTask.id}"]`)).toBeVisible();
    await expect(page.getByRole('region', { name: /^Done / }).locator(`.task-card[data-task-id="${charlieCreatedTask.id}"]`)).toBeVisible();
  });

  test('integrates filtering with permanent task deletion, manual refresh, active user switching and page reload reset', async ({ page, request }) => {
    const users = await getUsers(request, fixtureURL);
    const deleteTargetTitle = `Delete under filter ${randomUUID()}`;
    const createRes = await request.post(`${fixtureURL}/api/tasks`, {
      data: {
        title: deleteTargetTitle,
        description: 'To be deleted while filtered to Bob',
        priority: 'high',
        assigned_to: 2,
        created_by: 1,
      },
    });
    expect(createRes.status()).toBe(201);
    const deleteTarget = assertTask(await createRes.json());

    await page.goto(fixtureURL);
    const filterGroup = page.getByRole('group', { name: 'Task filters' });
    const assigneeSelect = filterGroup.getByLabel('Assignee');
    const statusSelect = filterGroup.getByLabel('Status');
    const prioritySelect = filterGroup.getByLabel('Priority');
    const clearButton = filterGroup.getByRole('button', { name: 'Clear Filters', exact: true });

    // Integration Test 11: Deletion Under Filters.
    await assigneeSelect.selectOption('2');
    await prioritySelect.selectOption('high');
    const beforeDeleteTasks = await getTasks(request, fixtureURL);
    const beforeFiltered = beforeDeleteTasks.filter(t => t.assigned_to === 2 && t.priority === 'high');
    const beforeTodoFilteredCount = beforeFiltered.filter(t => t.status === 'todo').length;
    await expectBoard(page, beforeFiltered, users, { filtered: true });

    const targetCard = page.locator(`.task-card[data-task-id="${deleteTarget.id}"]`);
    await expect(targetCard).toBeVisible();
    await targetCard.locator('.task-card-trigger').click();

    const detailsDialog = page.getByRole('dialog', { name: 'Task Details' });
    await detailsDialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    const deleteRefreshPromise = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'GET');
    await detailsDialog.getByRole('button', { name: 'Delete task', exact: true }).click();
    await deleteRefreshPromise;

    await expect(detailsDialog).toHaveCount(0);
    await expect(targetCard).toHaveCount(0);
    await expect(page.getByRole('heading', { name: `To do (${beforeTodoFilteredCount - 1})`, exact: true })).toBeVisible();

    // Clearing filters does not restore the deleted task.
    await clearButton.click();
    const afterDeleteTasks = await getTasks(request, fixtureURL);
    expect(afterDeleteTasks.some(t => t.id === deleteTarget.id)).toBe(false);
    await expectBoard(page, afterDeleteTasks, users);
    await expect(targetCard).toHaveCount(0);

    // Integration Test 12: Active user switching independence, manual refresh preservation, and reload reset.
    await assigneeSelect.selectOption('2');
    await statusSelect.selectOption('todo');
    await prioritySelect.selectOption('high');

    // Switching active user in header does not alter assigneeFilter or other filters.
    await page.getByLabel('Current user').selectOption('3');
    await expect(page.locator('.current-user strong')).toHaveText('Charlie');
    await expect(assigneeSelect).toHaveValue('2');
    await expect(statusSelect).toHaveValue('todo');
    await expect(prioritySelect).toHaveValue('high');

    // Insert a matching task and a non-matching task directly in PostgreSQL, then click manual Refresh.
    const refreshedMatchTitle = `Refreshed match ${randomUUID()}`;
    const refreshedNonMatchTitle = `Refreshed non-match ${randomUUID()}`;
    sql(`INSERT INTO tasks(title, description, status, priority, assigned_to, created_by) VALUES ('${refreshedMatchTitle}', NULL, 'todo', 'high', 2, 3), ('${refreshedNonMatchTitle}', NULL, 'todo', 'low', 1, 3);`);

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(assigneeSelect).toHaveValue('2');
    await expect(statusSelect).toHaveValue('todo');
    await expect(prioritySelect).toHaveValue('high');
    await expect(page.getByRole('heading', { name: refreshedMatchTitle, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: refreshedNonMatchTitle, exact: true })).toHaveCount(0);

    const refreshedTasks = await getTasks(request, fixtureURL);
    await expectBoard(
      page,
      refreshedTasks.filter(t => t.assigned_to === 2 && t.status === 'todo' && t.priority === 'high'),
      users,
      { filtered: true },
    );

    // Full browser page reload resets all filters to default while preserving selected user identity (Charlie).
    await page.reload();
    await expect(page.getByLabel('Current user')).toHaveValue('3');
    await expect(page.locator('.current-user strong')).toHaveText('Charlie');
    await expect(assigneeSelect).toHaveValue('');
    await expect(statusSelect).toHaveValue('');
    await expect(prioritySelect).toHaveValue('');
    await expect(clearButton).toBeDisabled();
    await expectBoard(page, refreshedTasks, users);
  });
});
