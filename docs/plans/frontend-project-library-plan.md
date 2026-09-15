# Frontend Plan — Project Library, In-Editor Switcher, and Saving Mechanics

> Status: proposed. Companion to `docs/backend-project-crud-plan.md`, whose contracts
> (`GET /projects`, `PATCH /projects/{id}`, `DELETE /projects/{id}`, export naming) are now
> **implemented and landed** — see "Backend status" below. Scope: turn the single-document
> app into a multi-project one — a library on entry, a collapsible in-editor switcher,
> rename/delete, export naming, and an explicit save-state story.

> **Backend status (landed).** All endpoints this plan consumes now exist:
> - `GET /projects` -> `{ projects: ProjectSummary[] }`, sorted `updated_at`-desc.
> - `PATCH /projects/{id}` `{ name }` -> full `ProjectView`. Rejects empty/whitespace-only
>   names (400) and caps length at 200 chars.
> - `DELETE /projects/{id}` -> `204` (`404` if missing). Removes audio + exports.
> - `ProjectView` now carries `name`, `created_at`, `updated_at`; `ExportArtifactView`
>   carries `name`; `ExportRequest` accepts `name?`.
> - Export downloads set a friendly `Content-Disposition` (`<safe-name>-<YYYYMMDD>.<ext>`,
>   with RFC 5987 `filename*` so Arabic titles survive) on both 200 and 206 responses.
> - **The wire types in [types/api.ts](../frontend/src/types/api.ts) are already updated**
>   (`ProjectSummary`, `ProjectListResponse`, `PatchProjectRequest`, and the new fields),
>   so §3.1 is done. Endpoints/hooks (§3.2–§3.3) and all UI remain to build.

---

## 1. Where we are today

- Routing ([App.tsx](../frontend/src/App.tsx)): `/` = paste-a-URL landing
  ([LandingPage.tsx](../frontend/src/pages/LandingPage.tsx)); `/p/:projectId` = editor
  ([EditorPage.tsx](../frontend/src/pages/EditorPage.tsx)); `*` -> `/`.
- There is **no way to see existing projects**. You reach a project only by creating it
  (the id comes back from `POST /projects`) or by already knowing its URL. Refreshing
  `/p/:id` re-fetches by id and works, but the app never lists what exists.
- Header ([AppHeader.tsx](../frontend/src/components/layout/AppHeader.tsx)) is a wordmark +
  a "New" button that navigates to `/`. Shell
  ([AppShell.tsx](../frontend/src/components/layout/AppShell.tsx)) is header + full-bleed
  main; explicitly "no sidebar, single-document tool."
- Server state is React Query; local UI state is Zustand
  ([editStore.ts](../frontend/src/stores/editStore.ts),
  [markerStore.ts](../frontend/src/stores/markerStore.ts)). Edits already persist per-mutation
  via `usePutEdl` / `useUpdateMarkers`
  ([hooks.ts:104](../frontend/src/api/hooks.ts#L104)). Undo/redo is client-only and not
  persisted — by design.

**Implication:** saving already works. The gaps are navigation (a library + switcher),
metadata management (rename/delete/export naming), and making the existing autosave
*visible* and *robust*.

---

## 2. Target navigation model

| Route | View | Notes |
|---|---|---|
| `/` | **Project library** (new) | List of projects; entry point for the whole app |
| `/new` | **New project** (paste URL) | The current `LandingPage` form, moved here |
| `/p/:projectId` | Editor | Core unchanged; header gains a switcher |
| `*` | -> `/` | unchanged |

Decision: entering the app lands on the **library**, not on the last project. This is the
clearest model for "multiple projects and switching." (Optional enhancement in 7.4:
remember and offer the last-opened project.)

---

## 3. API layer additions

### 3.1 Types ([types/api.ts](../frontend/src/types/api.ts)) — DONE

Already landed, mirroring the backend contracts:

```ts
interface ProjectSummary {          // note: named ProjectSummary, not ...View
  id: string; name: string; source_url: string; duration_sec: number;
  created_at: string; updated_at: string; status: ProjectStatus; export_count: number;
}
interface ProjectListResponse { projects: ProjectSummary[] }   // body of GET /projects
interface PatchProjectRequest { name: string }
// ProjectView       += name, created_at, updated_at
// ExportArtifactView += name
// ExportRequest      += name?
```

### 3.2 Endpoints ([endpoints.ts](../frontend/src/api/endpoints.ts))

```ts
listProjects()                      -> GET    /projects        // ProjectListResponse -> .projects
renameProject(id, name)             -> PATCH  /projects/{id}   // ProjectView
deleteProject(id)                   -> DELETE /projects/{id}   // 204
```

Add `queryKeys.projects = ["projects"] as const`. `renameProject` surfaces a 400 for
blank names — validate/trim in the rename UI before firing to avoid the round-trip.

### 3.3 Hooks ([hooks.ts](../frontend/src/api/hooks.ts))

- `useProjects()` — `useQuery(queryKeys.projects, listProjects)`. Moderate `staleTime`
  (e.g. 30s); refetch on window focus so the library stays fresh.
- `useRenameProject()` — mutation; `onSuccess` patches both `queryKeys.project(id)` and the
  matching entry in `queryKeys.projects`.
- `useDeleteProject()` — mutation; `onSuccess` invalidates `queryKeys.projects` and removes
  the project's cached queries.
- Extend `useExport` payload to include `name`.

---

## 4. Project library page (`/`)

New `frontend/src/pages/ProjectLibraryPage.tsx`.

- **Data:** `useProjects()`. States: loading spinner; error `Alert`; empty state
  ("No projects yet — start from a link", CTA -> `/new`, reuse existing `EmptyState`).
- **Layout:** responsive card grid, sorted by `updated_at` desc (server already sorts;
  keep client-side stable). Each card shows:
  - `name` (the editable title),
  - source host + formatted `duration_sec` (reuse [lib/time.ts](../frontend/src/lib/time.ts)),
  - relative `updated_at` ("edited 2h ago"),
  - status badges from `status` (extracted / analyzed / edited) using existing `Badge`,
  - export count when `> 0`.
- **Primary action:** click card -> `navigate(/p/{id})`.
- **Per-card menu** (kebab): **Rename** (inline input or small modal -> `useRenameProject`),
  **Delete** (confirm modal -> `useDeleteProject`), and when `export_count > 0` a
  **Download latest** shortcut (links to the newest artifact's `download_url`).
- **New project:** a prominent "New project" card/button -> `/new`.

Delete confirmation is required (it removes audio + exports irreversibly). Rename is
optimistic with rollback on error.

---

## 5. New project flow (`/new`)

Move the current [LandingPage.tsx](../frontend/src/pages/LandingPage.tsx) body to
`/new` (rename to `NewProjectPage` or keep as a modal launched from the library — a route
is simpler and deep-linkable). On success it already navigates to `/p/:id` carrying the
`jobId` in router state; keep that. Add a "Back to library" affordance.

The wordmark/"home" in the header now points to `/` (the library) rather than the paste
form — see §6.

---

## 6. Editor header: collapsible project switcher

Rework [AppHeader.tsx](../frontend/src/components/layout/AppHeader.tsx) so it is
context-aware. The header is always present (it lives in `AppShell`), but its middle region
changes:

- **On `/` and `/new`:** wordmark only (as today), wordmark -> `/`.
- **On `/p/:id`:** show the **current project name** as a button that opens a **collapsible
  switcher** — a dropdown/popover listing projects (`useProjects()`), each row navigating to
  `/p/{otherId}`. Include a "New project" row (-> `/new`) and a "Back to all projects" row
  (-> `/`). The current project is marked active.

Collapsible behavior: the switcher is collapsed by default (just the current project name +
chevron); clicking expands the list; selecting or clicking away collapses it. Keep it
keyboard-accessible (existing UI primitives: `Tooltip`, `Button`; add a lightweight popover
or reuse `Modal` for small screens).

Because the switcher needs the current project's `name`, the editor passes it down, or the
header reads it from the `queryKeys.project(id)` cache via `projectId` parsed from the route
(`useParams`). Prefer reading from cache so the header has no prop coupling to `EditorPage`.

Rename entry point: allow renaming from the switcher header too (click the name to edit), so
users can rename without returning to the library.

The existing "New" (+) button stays, now clearly navigating to `/new`.

---

## 7. Saving mechanics

The core requirement — "save during editing for resilience on app close" — is **already
met**: each EDL/marker change PUTs synchronously and the backend writes atomically. This
section makes that durable-by-default behavior *visible* and *hardened*, and defines the
new metadata saves.

### 7.1 Save-state indicator

Add a small status element in the editor header driven by the existing mutations:

- Derive `saving` from `usePutEdl().isPending || useUpdateMarkers().isPending`.
- Derive `error` from either mutation's `isError`.
- Render: `Saving…` (spinner) / `All changes saved` (check, from `updated_at`) / `Save
  failed — retry` (from error, with a retry button that re-fires the last mutation).

This reassures the user that closing the app is safe and surfaces the rare failed write
instead of silently dropping it.

### 7.2 Failure handling + retry

Today a failed `PUT` leaves the React Query cache patched only on success
([hooks.ts:109](../frontend/src/api/hooks.ts#L109)), so a failed save does not corrupt local
state, but the user is not told. Add:

- A toast on save failure (reuse [Toast.tsx](../frontend/src/components/ui/Toast.tsx)).
- Automatic retry with backoff on 5xx/network (React Query mutation retry), stop on 4xx.
- A `beforeunload` guard **only while a save is genuinely in flight** (any edit mutation
  `isPending`), warning before close. Do not guard on idle — normal closes must be seamless
  since idle state is already fully persisted.

### 7.3 Debounce consideration (optional)

Edits currently PUT immediately per commit (undo/redo snapshot boundaries), which is fine
for discrete cut/marker operations. If a future interaction produces rapid continuous edits
(e.g. dragging a region boundary), add a short debounce (~300–500ms trailing) in
`usePutEdl`/`useUpdateMarkers` callers so we coalesce writes. Not needed for the current
discrete-edit model; note and defer.

### 7.4 Startup / last-opened (optional enhancement)

Persist the last-opened `projectId` in `localStorage`. On landing at `/`, the library can
surface a "Resume {name}" shortcut. Entry still defaults to the library (§2); this is a
convenience, not the default path.

---

## 8. Export naming (frontend side)

In [ExportModal.tsx](../frontend/src/features/export/ExportModal.tsx):

- Add a **Name** input (defaulting to the project `name`) passed as `name` in the
  `ExportRequest`.
- The download `<a>` already uses `exportDownloadUrl`; the backend now sets a friendly
  `Content-Disposition` filename (`<safe-name>-<YYYYMMDD>.<ext>`). The header wins on
  download, so the `download` attribute is optional; set it to the same friendly name only
  as a fallback.
- Optional: show a small list of prior exports for the project (from `project.exports`,
  each now carrying `name` + `download_url`) so users can re-download without re-rendering.

---

## 9. Component / file summary

New:
- `pages/ProjectLibraryPage.tsx` — the library grid (§4).
- `pages/NewProjectPage.tsx` — moved paste-URL flow (§5), or a modal variant.
- `features/projects/ProjectSwitcher.tsx` — collapsible in-editor switcher (§6).
- `features/projects/ProjectCard.tsx`, `RenameDialog.tsx`, `DeleteDialog.tsx` — library bits.
- `components/SaveStatus.tsx` — save-state indicator (§7.1).

Changed:
- [App.tsx](../frontend/src/App.tsx) — add `/` (library) and `/new`; keep `/p/:id`.
- [AppHeader.tsx](../frontend/src/components/layout/AppHeader.tsx) — context-aware header +
  switcher mount; wordmark -> `/`.
- [api/endpoints.ts](../frontend/src/api/endpoints.ts),
  [api/hooks.ts](../frontend/src/api/hooks.ts),
  [types/api.ts](../frontend/src/types/api.ts) — list/rename/delete + new fields (§3).
- [ExportModal.tsx](../frontend/src/features/export/ExportModal.tsx) — name input (§8).
- [EditorPage.tsx](../frontend/src/pages/EditorPage.tsx) — mount `SaveStatus`; expose
  current project name to the header via cache (§6, §7.1).

---

## 10. Sequencing

1. API layer: types (§3.1 **done**) + endpoints + hooks (§3.2–§3.3). Backend has landed,
   so this is unblocked.
2. Library page + routing split `/` and `/new` (§2, §4, §5). Delivers "project pages upon
   entering."
3. Context-aware header + collapsible switcher (§6). Delivers in-editor switching.
4. Save-state indicator + failure handling (§7.1, §7.2). Makes the existing autosave visible
   and robust.
5. Export naming UI (§8). Small, independent.
6. Optional: debounce (§7.3), last-opened resume (§7.4).

Steps 2–4 are the heart of the request. Step 1's prerequisite (backend contract) has
landed, and its types are already in `api.ts`.

---

## 11. Notes / decisions to confirm

- Entry = library (not auto-open last project). Changeable if you prefer resume-on-launch.
- Rename is available from both the library and the in-editor switcher.
- Delete requires confirmation and removes audio + exports; the shared download cache is
  untouched (backend plan §3.2).
- No pagination/search in v1 (single user, modest project counts).
