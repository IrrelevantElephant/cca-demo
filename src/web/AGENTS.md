# Frontend

See [technical debt and pitfalls](../../docs/TECHDEBT.md) for the Vite API setup, testing gaps, and documentation limitations.

## Structure and conventions
- React 19 with TypeScript and Vite; pnpm is the package manager.
- `src/main.tsx` mounts the app inside React StrictMode.
- `src/App.tsx` fetches users, handles selection and loading/error/empty states, and renders the RecoverBoard shell.
- `src/types.ts` defines the API-facing User type, UserContext, and `useCurrentUser`. Keep it aligned with Go's `User` and the SQL schema.
- `src/App.css` contains component/layout styling; `src/index.css` contains global styles. Follow the existing plain-CSS approach rather than adding a UI framework unnecessarily.
- TypeScript is strict with unused-local/parameter checks and verbatim module syntax. Use type-only imports where appropriate.

## Behavior to preserve
- Fetch from the same-origin `/api/users` endpoint and validate the returned user array.
- Selected IDs persist under `recoverboard.selectedUserId`. Restore a valid saved user, fall back to the first available user, and clear the stored selection for an empty list.
- Keep loading, retryable failure, and empty states distinct. Preserve accessible labels, status/alert roles, keyboard focus styling, and the narrow-screen layout.
- User selection is a local UI preference, not a security boundary.
- The shared task board loads from `GET /api/tasks`, supports client-side filtering by assignee, status, and priority with `Clear Filters`, supports creating tasks via `POST /api/tasks` (`CreateTaskDialog.tsx`), supports editing task details (`TaskDetailsDialog.tsx`) and quick card status transitions via `PUT /api/tasks/{id}`, and supports permanent task deletion via `DELETE /api/tasks/{id}` after an explicit confirmation step in `TaskDetailsDialog.tsx`. `TaskBoard.tsx` owns abortable initial/refresh requests, in-memory filter state, functional replace/remove-by-ID updates, stale-GET protection during mutations, and last-valid-snapshot retention on failure; `taskApi.ts` validates payloads, parses structured error responses, and safely diagnoses omitted records. User selection must not refetch or filter tasks. Dashboard summary counts derive from the complete snapshot, not filtered cards; initial failures must not display zero totals. Confirmed creates are retained if their follow-up refresh fails. Both task dialogs use `dialogFocus.ts` to wrap keyboard focus.

## Commands and checks
Run from this directory:
- `pnpm install --frozen-lockfile`
- `pnpm dev` for the Vite development server.
- `pnpm lint`
- `pnpm build` for TypeScript project checks and the production bundle.
- `pnpm preview` to preview the built static assets.

Use the complete Compose stack or build assets and serve them through Go for end-to-end checks. For standalone Vite limitations and proposed improvements, see `../../docs/TECHDEBT.md`.

For UI changes, check successful loading, saved-selection restoration, switching users, empty/malformed/error responses and retry, plus mobile and keyboard behavior. Do not edit generated `dist/` output.
