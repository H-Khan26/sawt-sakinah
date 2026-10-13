# Frontend Plan — Library, In-Editor Switcher, and Saving Mechanics

> Status: implemented; kept as a design record. Companion to
> `docs/plans/backend-project-crud-plan.md`, whose contracts (`GET /projects`,
> `PATCH /projects/{id}`, `DELETE /projects/{id}`, export naming) landed first — see
> "Backend status" below. Scope: turn the single-document
> app into a multi-recording one — a library on entry, a collapsible in-editor switcher,
> rename/delete, export naming, and an explicit save-state story.

> **As built.** `/` is the library ("Your recordings",
> [ProjectLibraryPage.tsx](../../frontend/src/pages/ProjectLibraryPage.tsx)) set under the
> Sanctuary dome ([LibraryShell.tsx](../../frontend/src/components/layout/LibraryShell.tsx)):
> recordings show as `NicheCard` niches or `FihristList` rows, each with title, length and
> date, and a ⋯ `ProjectMenu` for Rename and Delete. `/new` opens the New recording sheet
> (`NewRecordingSheet`) over the library. The editor has no app header: an 88 px binding
> rail ([EditorShell.tsx](../../frontend/src/components/layout/EditorShell.tsx)) carries
> the app mark, Library and New recording, and the title row sets the recording name in a
> cartouche that opens the recording switcher (`ProjectSwitcher`).

> **Backend status (landed).** All endpoints this plan consumes now exist:
> - `GET /projects` -> `{ projects: ProjectSummary[] }`, sorted `updated_at`-desc.
> - `PATCH /projects/{id}` `{ name }` -> full `ProjectView`. Rejects empty/whitespace-only
>   names (400) and caps length at 200 chars.
> - `DELETE /projects/{id}` -> `204` (`404` if missing). Removes audio + exports.
> - `ProjectView` now carries `name`, `created_at`, `updated_at`; `ExportArtifactView`
>   carries `name`; `ExportRequest` accepts `name?`.
> - Export downloads set a friendly `Content-Disposition` (`<safe-name>-<YYYYMMDD>.<ext>`,
>   with RFC 5987 `filename*` so Arabic titles survive) on both 200 and 206 responses.
> - **The wire types in [types/api.ts](../../frontend/src/types/api.ts) are already updated**
>   (`ProjectSummary`, `ProjectListResponse`, `PatchProjectRequest`, and the new fields),
>   so §3.1 is done. Endpoints/hooks (§3.2–§3.3) and all UI remain to build.

---

## 1. Starting point

- Routing ([App.tsx](../../frontend/src/App.tsx)): `/` = a paste-a-URL form;
  `/p/:projectId` = editor ([EditorPage.tsx](../../frontend/src/pages/EditorPage.tsx));
  `*` -> `/`.
- There is **no way to see existing recordings**. You reach a recording only by creating it
  (the id comes back from `POST /projects`) or by already knowing its URL. Refreshing
  `/p/:id` re-fetches by id and works, but the app never lists what exists.
- A slim app header holds the app name and a "New" button that navigates to `/`; the shell
  is header + full-bleed main, a single-document tool with no sidebar.
- Server state is React Query; local UI state is Zustand
  ([editStore.ts](../../frontend/src/stores/editStore.ts),
  [markerStore.ts](../../frontend/src/stores/markerStore.ts)). Edits already persist per-mutation
  via `usePutEdl` / `useUpdateMarkers`
  ([hooks.ts:104](../../frontend/src/api/hooks.ts#L104)). Undo/redo is client-only and not
  persisted — by design.

**Implication:** saving already works. The gaps are navigation (a library + switcher),
metadata management (rename/delete/export naming), and making the existing autosave
*visible* and *robust*.

---

## 2. Target navigation model

| Route | View | Notes |
|---|---|---|
| `/` | **Library** ("Your recordings") | List of recordings; entry point for the whole app |
| `/new` | **New recording** sheet | Paste a URL or drop a file; opens over the library |
| `/p/:projectId` | Editor | Core unchanged; the title cartouche is the switcher |
| `*` | -> `/` | unchanged |

Decision: entering the app lands on the **library**, not on the last project. This is the
clearest model for "multiple recordings and switching." (Optional enhancement in 7.4:
remember and offer the last-opened recording.)

---

## 3. API layer additions

### 3.1 Types ([types/api.ts](../../frontend/src/types/api.ts)) — DONE

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

### 3.2 Endpoints ([endpoints.ts](../../frontend/src/api/endpoints.ts))

```ts
listProjects()                      -> GET    /projects        // ProjectListResponse -> .projects
renameProject(id, name)             -> PATCH  /projects/{id}   // ProjectView
deleteProject(id)                   -> DELETE /projects/{id}   // 204
```

Add `queryKeys.projects = ["projects"] as const`. `renameProject` surfaces a 400 for
blank names — validate/trim in the rename UI before firing to avoid the round-trip.

### 3.3 Hooks ([hooks.ts](../../frontend/src/api/hooks.ts))

- `useProjects()` — `useQuery(queryKeys.projects, listProjects)`. Moderate `staleTime`
  (e.g. 30s); refetch on window focus so the library stays fresh.
- `useRenameProject()` — mutation; `onSuccess` patches both `queryKeys.project(id)` and the
  matching entry in `queryKeys.projects`.
- `useDeleteProject()` — mutation; `onSuccess` invalidates `queryKeys.projects` and removes
  the project's cached queries.
- Extend `useExport` payload to include `name`.

---

## 4. Library page (`/`)

New `frontend/src/pages/ProjectLibraryPage.tsx`.

- **Data:** `useProjects()`. States: loading spinner; error `Alert`; empty state
  ("No recordings yet", CTA -> `/new`).
- **Layout:** an arcade of `NicheCard` niches or a `FihristList` (view toggle), sorted by
  `updated_at` desc (server already sorts; keep client-side stable). The plan for each
  entry:
  - `name` (the editable title),
  - source host + formatted `duration_sec` (reuse [lib/time.ts](../../frontend/src/lib/time.ts)),
  - relative `updated_at` ("edited 2h ago"),
  - status badges from `status` (extracted / analyzed / edited) using existing `Badge`,
  - export count when `> 0`.
- **Primary action:** click a niche or row -> `navigate(/p/{id})`.
- **Per-recording menu** (⋯ `ProjectMenu`): **Rename** (small modal -> `useRenameProject`),
  **Delete** (confirm modal -> `useDeleteProject`), and when `export_count > 0` a
  **Download latest** shortcut (links to the newest artifact's `download_url`).
- **New recording:** a "New recording" button -> `/new`.

As built, each niche or row shows title, length and date only; there are no status badges
or export counts.

Delete confirmation is required (it removes audio + exports irreversibly). Rename is
optimistic with rollback on error.

---

## 5. New recording flow (`/new`)

`/new` stays a route (deep links, retry) and renders the library with the New recording
sheet ([NewRecordingSheet.tsx](../../frontend/src/features/projects/NewRecordingSheet.tsx))
open over it: a YouTube link field and a drop zone for a local file. On success it
navigates to `/p/:id` carrying the `jobId` in router state. Closing the sheet returns to
the library.

The app mark on the editor rail points to `/` (the library) — see §6.

---

## 6. Editor title: the recording switcher

Each layout carries its own chrome (see `AppShell`): the library sits under the Sanctuary
header (logo, lamp ring, theme switch and settings), and the editor beside the binding rail
(app mark -> `/`, Library, New recording -> `/new`, theme switch and settings).

- **On `/p/:id`:** the title row sets the **current recording name** in a cartouche
  ([ProjectSwitcher.tsx](../../frontend/src/features/projects/ProjectSwitcher.tsx)), a
  button that opens a popover listing recordings (`useProjects()`), each row navigating to
  `/p/{otherId}`. It includes a "New recording" row (-> `/new`) and an "All recordings"
  row (-> `/`). The current recording is marked active; unreadable ones are disabled.

The switcher is collapsed by default (just the cartouche); clicking opens the list;
selecting or clicking away closes it. It is keyboard-accessible.

The editor passes the current recording's `name` and id to the switcher as props.

Rename entry point: the current recording's name heads the popover and opens the rename
dialog, so users can rename without returning to the library.

---

## 7. Saving mechanics

The core requirement — "save during editing for resilience on app close" — is **already
met**: each EDL/marker change PUTs synchronously and the backend writes atomically. This
section makes that durable-by-default behavior *visible* and *hardened*, and defines the
new metadata saves.

### 7.1 Save-state indicator

Add a small status element in the editor's title row driven by the existing mutations:

- Derive `saving` from `usePutEdl().isPending || useUpdateMarkers().isPending`.
- Derive `error` from either mutation's `isError`.
- Render: `Saving…` (spinner) / `All changes saved` (check, from `updated_at`) / `Save
  failed — retry` (from error, with a retry button that re-fires the last mutation).

This reassures the user that closing the app is safe and surfaces the rare failed write
instead of silently dropping it.

### 7.2 Failure handling + retry

Today a failed `PUT` leaves the React Query cache patched only on success
([hooks.ts:109](../../frontend/src/api/hooks.ts#L109)), so a failed save does not corrupt local
state, but the user is not told. Add:

- A toast on save failure (reuse [Toast.tsx](../../frontend/src/components/ui/Toast.tsx)).
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

Persist the last-opened `projectId` in `localStorage`. On arriving at `/`, the library can
surface a "Resume {name}" shortcut. Entry still defaults to the library (§2); this is a
convenience, not the default path.

---

## 8. Export naming (frontend side)

In [ExportModal.tsx](../../frontend/src/features/export/ExportModal.tsx):

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
- `pages/ProjectLibraryPage.tsx` — the library (§4).
- `features/projects/NewRecordingSheet.tsx` — the New recording sheet over the library (§5).
- `features/projects/ProjectSwitcher.tsx` — the title cartouche and recording switcher (§6).
- `features/projects/NicheCard.tsx`, `FihristList.tsx`, `ProjectMenu.tsx`,
  `RenameDialog.tsx`, `DeleteDialog.tsx` — library bits.
- `components/SaveStatus.tsx` — save-state indicator (§7.1).

Changed:
- [App.tsx](../../frontend/src/App.tsx) — add `/` (library) and `/new`; keep `/p/:id`.
- [components/layout/](../../frontend/src/components/layout/) — `LibraryShell` (Sanctuary
  header) and `EditorShell` (binding rail; app mark -> `/`).
- [api/endpoints.ts](../../frontend/src/api/endpoints.ts),
  [api/hooks.ts](../../frontend/src/api/hooks.ts),
  [types/api.ts](../../frontend/src/types/api.ts) — list/rename/delete + new fields (§3).
- [ExportModal.tsx](../../frontend/src/features/export/ExportModal.tsx) — name input (§8).
- [EditorPage.tsx](../../frontend/src/pages/EditorPage.tsx) — mount `ProjectSwitcher`,
  `SaveStatus` and Export in the title row (§6, §7.1).

---

## 10. Sequencing

1. API layer: types (§3.1 **done**) + endpoints + hooks (§3.2–§3.3). Backend has landed,
   so this is unblocked.
2. Library page + routing split `/` and `/new` (§2, §4, §5). Delivers "project pages upon
   entering."
3. Title cartouche switcher (§6). Delivers in-editor switching.
4. Save-state indicator + failure handling (§7.1, §7.2). Makes the existing autosave visible
   and robust.
5. Export naming UI (§8). Small, independent.
6. Optional: debounce (§7.3), last-opened resume (§7.4).

Steps 2–4 are the heart of the request. Step 1's prerequisite (backend contract) has
landed, and its types are already in `api.ts`.

---

## 11. Notes / decisions to confirm

- Entry = library (not auto-open last recording). Changeable if you prefer resume-on-launch.
- Rename is available from both the library and the in-editor switcher.
- Delete requires confirmation and removes audio + exports; the shared download cache is
  untouched (backend plan §3.2).
- No pagination (single user, modest recording counts); a search field joins the
  library's heading row from 12 recordings on.
