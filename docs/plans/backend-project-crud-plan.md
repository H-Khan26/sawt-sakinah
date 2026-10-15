# Backend Plan — Project CRUD, Export Naming, and GET Efficacy

> Status: implemented; kept as a design record. Companion to
> `docs/plans/frontend-project-library-plan.md`. Scope: complete
> the CRUD surface for projects (list, rename, delete) on top of the existing create/read,
> add human-friendly export naming, and review the read-path (`GET`) mechanics for
> efficiency. Single-user, local/desktop assumptions hold throughout.
> The marker and phrase parts it describes (`PUT /projects/{id}/markers`, marker edits,
> phrase writes) were retired by the [Surah view](../frontend/04-surah-view.md); see
> [docs/audio/03-surah-recognition.md](../audio/03-surah-recognition.md).

---

## 1. Where we are today

The persistence layer already exists and is solid. `ProjectStore`
([projects.py](../../sawt_sakinah/service/projects.py)) writes each project as a directory:

```
<projects_root>/<project_id>/
  project.json     # Project.model_dump(mode="json"), atomic via os.replace
  audio/           # mp3 + optional 16kHz working-copy wav
  exports/<artifact_id>.<ext>
  waveform.json    # cached peaks (lazy)
```

Writes are crash-safe (temp-write + `os.replace`, [projects.py:109](../../sawt_sakinah/service/projects.py#L109)),
and `update()` serializes read-modify-write under a per-project lock so concurrent detection
jobs never clobber each other ([projects.py:118](../../sawt_sakinah/service/projects.py#L118)).

**Editing already autosaves.** Every EDL/marker edit is a synchronous atomic write via
`PUT /projects/{id}/edl` and `PUT /projects/{id}/markers`
([routes/projects.py](../../sawt_sakinah/service/routes/projects.py)). There is no unsaved
in-memory buffer to lose on app close. Undo/redo history is intentionally client-only and
is not persisted, which matches the "no history needed" requirement.

### CRUD status

| Operation | Endpoint | Status |
|---|---|---|
| Create | `POST /projects` (async extraction) | Exists |
| Read one | `GET /projects/{id}` | Exists |
| Read many (list) | — | **Missing** |
| Update — EDL | `PUT /projects/{id}/edl` | Exists |
| Update — markers | `PUT /projects/{id}/markers` | Exists |
| Update — rename/metadata | — | **Missing** |
| Delete | — | **Missing** |
| Export naming | exports are `{uuid}.{ext}`; download filename is the uuid | **Weak** |

The `Project` model ([project.py](../../sawt_sakinah/models/project.py)) has no project-level
`name`, `created_at`, or `updated_at`. Title lives on `audio_source.title`; the only edit
timestamp is `edl.updated_at`, which misses marker edits. A "recent projects" list needs a
real project-level `updated_at`.

---

## 2. Data model changes

### 2.1 `Project` gains identity + timestamps

In [models/project.py](../../sawt_sakinah/models/project.py), add three fields to `Project`:

```python
name: str                      # user-facing label; defaults to audio_source.title
created_at: datetime = Field(default_factory=_now)
updated_at: datetime = Field(default_factory=_now)
```

- `name` is what the library shows and what rename edits. On first creation it is seeded
  from `audio_source.title` (see 3.1).
- `updated_at` is the sort key for the library's "recently edited" ordering. It must be
  bumped on **every** write (see 2.3).

Because `Project` is frozen, all mutations already go through `model_copy(update=...)`, so
this is additive.

### 2.2 Backward compatibility for existing `project.json`

Existing files predate these fields. Make the load path tolerant rather than forcing a
migration script:

- In `ProjectStore.load()` ([projects.py:83](../../sawt_sakinah/service/projects.py#L83)),
  after `Project.from_dict(...)`, backfill any missing fields inside `_heal()`:
  - `name` -> `audio_source.title`
  - `created_at` -> `audio_source.created_at`
  - `updated_at` -> `created_at` (or the `project.json` file mtime, whichever is simpler)
- Give the new fields defaults on the model so `model_validate` does not reject old files
  in the first place; `_heal` then fills semantically correct values and the next `save`
  persists them. This is the same "heal on read" pattern already used for dangling files.

### 2.3 Bump `updated_at` centrally

In `ProjectStore.update()` ([projects.py:118](../../sawt_sakinah/service/projects.py#L118)),
after `mutator` returns, stamp the result before saving:

```python
updated = mutator(project)
updated = updated.model_copy(update={"updated_at": _now()})
self.save(updated)
```

`update()` is the single choke point for all post-creation writes (EDL, markers, silences,
phrases, exports), so this one change keeps `updated_at` accurate for the library without
touching any route. `create()` sets `created_at == updated_at` naturally.

### 2.4 Export artifact gains an optional name

In [models/project.py](../../sawt_sakinah/models/project.py), `ExportArtifact` gains:

```python
name: Optional[str] = None     # user-supplied export label, used for the download filename
```

The on-disk file stays `{artifact_id}.{ext}` (collision-safe, path-traversal-safe). `name`
only drives the `Content-Disposition` filename on download (see 4).

---

## 3. New store methods

Add to `ProjectStore` ([projects.py](../../sawt_sakinah/service/projects.py)):

### 3.1 `list_summaries() -> list[ProjectSummary]`

Enumerate `self.root` for child dirs containing `project.json` and return a lightweight
summary per project. **Do not** run the full `load()` + `_heal()` per project — healing
stats every audio and export file, which is wasteful across a whole library. Instead read
each `project.json` once and project out only the summary fields:

```python
ProjectSummary:
  id: str
  name: str
  source_url: str
  duration_sec: float
  created_at: datetime
  updated_at: datetime
  status: ProjectStatus          # extracted / analyzed / edited
  export_count: int
  # optional, cheap: has_markers / has_silences booleans or counts
```

Sort by `updated_at` desc. A project mid-extraction has no `project.json` yet (it is written
only when extraction completes, [workers.py:90](../../sawt_sakinah/service/workers.py#L90)); such
dirs are simply skipped, which is correct — the library shows completed/extracting projects
via the jobs channel, not half-written dirs.

Corrupt/unreadable `project.json` is skipped (same tolerance as `load`).

> Scale note: reading every `project.json` for the list is fine at desktop scale (tens to a
> few hundred projects), especially once large data (future transcripts) lives in its own
> sidecar file rather than inside `project.json` (see 6). If the count ever grows large,
> the drop-in optimization is a tiny per-project `meta.json` sidecar written on save and
> scanned here — but do not build that yet.

### 3.2 `delete(project_id) -> bool`

Remove the whole project directory (`shutil.rmtree`) under the per-project lock. Returns
`False` if the dir did not exist.

- **Cache is untouched.** The extraction cache lives in a separate `cache_dir`
  ([settings.py:44](../../sawt_sakinah/service/settings.py#L46)) and each project owns copies of
  its audio (`_localize`, [workers.py:41](../../sawt_sakinah/service/workers.py#L41)), so
  deleting one project never strands another. Deleting a project does **not** evict the
  shared download cache — correct, since another project may reuse it.
- Drop the in-memory lock entry for the id after deletion to avoid unbounded lock-map growth.

### 3.3 `rename(project_id, name) -> Project`

Thin wrapper over `update()` with a mutator that sets `name`. Could also be inlined in the
route; a named method keeps the store the single persistence surface.

---

## 4. Export naming

Goal: a downloaded export is named after the project (and optional user label), not a UUID.

### 4.1 Request + worker

- `ExportRequest` ([schemas.py:95](../../sawt_sakinah/service/schemas.py#L95)) gains
  `name: Optional[str] = None`.
- `export_worker` ([workers.py:178](../../sawt_sakinah/service/workers.py#L178)) writes the
  `name` onto the `ExportArtifact`. Keep the on-disk path as `{artifact_id}.{format}` — do
  **not** name files by user input (avoids collisions and path-traversal). Default `name`
  when omitted: the project `name`.

### 4.2 Download filename

In `download_export` ([routes/export.py:38](../../sawt_sakinah/service/routes/export.py#L38)),
build a human filename instead of passing `filename=path.name`:

```
<slug(project.name or artifact.name)>-<created_at:%Y%m%d>.<ext>
```

- Slugify to a filesystem/HTTP-safe ASCII-ish string (strip/replace path separators,
  quotes, control chars; collapse whitespace to `-`). Arabic titles: either transliterate
  to a safe fallback or percent-encode via `Content-Disposition: attachment; filename*=UTF-8''...`
  (RFC 5987) so unicode titles survive. Prefer `filename*` with a plain-ASCII `filename`
  fallback for old clients.
- `ranged_file_response` already accepts a `filename` param; extend it (or set the header at
  the route) to emit both `filename` and `filename*`.

### 4.3 Wire view

`ExportArtifactView` ([schemas.py:117](../../sawt_sakinah/service/schemas.py#L117)) gains `name`
so the frontend can show export labels in a list. `download_url` is unchanged.

---

## 5. New / changed routes

All under the existing `projects.router`
([routes/projects.py](../../sawt_sakinah/service/routes/projects.py)).

### 5.1 `GET /projects` — list

```
GET /projects  ->  200  { projects: ProjectSummaryView[] }
```

- Calls `store.list_summaries()`, maps to a path-free `ProjectSummaryView` (mirrors the
  `to_project_view` path-stripping discipline — no `local_path` leaks).
- Returns `updated_at`-desc. No pagination in v1 (single user); add `?limit/offset` only if
  needed.

### 5.2 `PATCH /projects/{id}` — rename / metadata

```
PATCH /projects/{id}  { name }  ->  200  ProjectView
```

- `validate_id`, then `store.rename(id, name)` (or `store.update` with a name mutator).
- Reject empty/whitespace-only names (400). Cap length (e.g. 200 chars).
- 404 via the existing `KeyError -> HTTPException` pattern.
- Returns the full `ProjectView` so the client patches its cache in one shot (same
  convention as `PUT /markers`).

### 5.3 `DELETE /projects/{id}`

```
DELETE /projects/{id}  ->  204
```

- `validate_id`, then `store.delete(id)`. 404 if it did not exist.
- **Running-job interaction:** jobs are in-memory and keyed by id; a detection/export job
  targeting a just-deleted project will fail on its next `store.load` with `KeyError` and be
  recorded as a failed job — acceptable and self-cleaning. Optionally, best-effort mark any
  in-flight job for that `project_id` as failed on delete for a cleaner client signal
  (requires a `jobs.cancel_for_project` helper; nice-to-have, not required for v1).

### 5.4 Registration

No change to `create_app` router wiring ([app.py:96](../../sawt_sakinah/service/app.py#L96)) —
these are new methods on the existing `projects.router`.

---

## 6. GET efficacy review

Findings and recommended fixes, ordered by impact.

### 6.1 Audio range requests re-parse `project.json` on every chunk (fix)

`GET /projects/{id}/audio` ([routes/media.py:21](../../sawt_sakinah/service/routes/media.py#L21))
calls `store.load()` — a full JSON parse **plus** `_heal()` (which stats `working_copy` and
every export file) — solely to read `audio_source.local_path`. The browser issues many range
requests while seeking/scrubbing the waveform, so this cost repeats per chunk. It is cheap
today but scales with `project.json` size (a concern once transcripts land).

**Fix options (pick one):**
- Add `ProjectStore.audio_path(project_id) -> Path | None` that resolves the streamable file
  without parsing the whole project or healing. Simplest robust form: read `project.json`
  and pull only `audio_source.local_path` (skip `_heal`); or resolve deterministically from
  the `audio/` dir.
- Or a small in-process LRU/dict cache `{project_id -> resolved audio Path}` invalidated on
  delete. Given audio paths are immutable for a project's life, this is safe and removes all
  repeat parsing.

### 6.2 `GET /waveform` loads the whole project just for a path (minor)

`get_waveform` ([routes/media.py:36](../../sawt_sakinah/service/routes/media.py#L36)) calls
`store.load()` even on a cache hit, only to reach `local_path` for the recompute branch.
Reorder so a `waveform.json` cache hit returns **before** loading the project; only load
(or use the 6.1 path resolver) when a recompute is actually needed. Waveform is immutable
per source, so also consider `Cache-Control: immutable` + an `ETag` (the client already
caches it with infinite `staleTime`, so this is polish).

### 6.3 List path must avoid `load()`/`_heal()` per project (already covered)

See 3.1 — `list_summaries` reads each `project.json` once without healing. Do not implement
the list by calling `load()` in a loop.

### 6.4 `GET /projects/{id}` heals on every fetch (leave as-is)

A single-project fetch healing dangling refs is correct and cheap. No change.

---

## 7. Wire contract additions (shared with frontend plan)

New/changed response shapes (add to [schemas.py](../../sawt_sakinah/service/schemas.py) and
mirror in [frontend/src/types/api.ts](../../frontend/src/types/api.ts)):

```
ProjectSummaryView { id, name, source_url, duration_sec, created_at,
                     updated_at, status, export_count }

ProjectView   += name, created_at, updated_at
ExportArtifactView += name
ExportRequest += name?
PatchProjectRequest { name }
```

`GET /projects -> { projects: ProjectSummaryView[] }`, `PATCH /projects/{id} -> ProjectView`,
`DELETE /projects/{id} -> 204`.

---

## 8. Sequencing

1. Model fields + backward-compat backfill (2.1, 2.2) and central `updated_at` bump (2.3).
   Nothing user-visible yet; unblocks everything else.
2. `ExportArtifact.name` + export naming end-to-end (2.4, 4). Self-contained.
3. Store methods `list_summaries` / `delete` / `rename` (3) + `ProjectSummary`.
4. Routes `GET /projects`, `PATCH`, `DELETE` (5) + wire views (7).
5. GET efficacy fixes 6.1 and 6.2 (independent; can land anytime after 1).

Steps 1-4 are the critical path for the frontend library. Step 5 is an independent
performance pass.

---

## 9. Out of scope / deferred

- SQLite/Postgres migration. The file store meets all stated goals; `ProjectStore` is the
  single seam, so a later move (driven by full-text transcript search via SQLite FTS5) is
  localized to one module and needs no route/frontend changes. Keep transcripts in a
  separate sidecar (`transcript.json`) when they arrive so `project.json` stays small.
- Job persistence across restart (`resilient-processing.md` B1). Editing data is already
  durable; only in-flight extraction/detection is lost on restart. Separate effort.
- Pagination / search / multi-user. Not needed for single-user desktop v1.
