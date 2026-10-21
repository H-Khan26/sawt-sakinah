# Surah View

> Status: implemented (`src/features/surahs/`). Shows which surahs a recording holds and
> where, on the waveform and in the Surahs column, and lets the user keep a surah or copy it
> into a new recording.

## Goal

Answer "what is recited here, and where?" at a glance: tint each recognised passage on the
waveform, name it in a band above the bars, list the surahs beside the tools, and turn a
surah into an edit (keep only it) or a new recording in one step. Recognition is the
backend's job (see [../audio/03-surah-recognition.md](../audio/03-surah-recognition.md));
the UI starts it, shows the result, and acts on it.

The result has to be trusted before it is acted on. Unsure passages are shown, flagged, but
never acted on; edges are padded into the pauses, so a passage may start or end a few
seconds generously.

## Data in / out

- **In:** `ProjectView.surahs`, a `SurahMap` (`model`, `matched_at`, `passages`) or `null`
  until matching has run. Each `SurahPassage` is `{ surah, ayah_from, ayah_to, start, end,
  confidence, level }` on the source timeline, `level` being `accept` or `unsure`. The
  surah table (`GET /quran/surahs`: `number`, Arabic `name`, transliteration `tname`,
  `ename`, `ayas`, `type`) supplies names and ayah counts; it is fixed data, cached for the
  session.
- **Out:** `POST /projects/{id}/detect/surahs` (`{ reuse_transcript: true }`) to match;
  cut ops on the EDL for Keep only; `POST /projects/{id}/split` (`{ ranges, name }`) for New
  recording; `embed_chapters` on export. See
  [../audio/05-data-model-and-api.md](../audio/05-data-model-and-api.md).

Matching never runs on its own: the user presses **Find surahs**.

## On the waveform

Three DOM layers, never wavesurfer regions (`useEditRegions` stays the Regions plugin's
single owner), all in [SurahBand.tsx](../../frontend/src/features/surahs/SurahBand.tsx):

- **The band** (`SurahBand`, in `WaveformView`'s `overlay` slot): one tab per passage in
  the 30 px notes margin, standing on the top rule. A tab shows the surah's transliterated
  name in Ibarra italic from 48 px wide, and its ayah range (and "Unsure") from 120 px; a
  narrower tab keeps its colour and names the passage in its tooltip. The tooltip and
  accessible name read `Al-Mulk · ayat 1–30 · 3:12–7:40` (times on the edited timeline,
  `· unsure` added for an unsure passage). A tab is clipped to the viewport, so a passage
  scrolled half out keeps its label in view. Clicking it selects the surah and seeks to
  that passage.
- **The tints** (`SurahTints`, in `WaveformView`'s new `underlay` slot): a wash behind the
  bars across each passage, edged with faint ink, so the bars draw over it.
- **The overview tints** (`SurahOverviewTints`, through `WaveformOverview`'s new `overlay`
  prop): the same washes over the overview strip, placed as fractions of the edited
  timeline.

Each passage's source edges go through the `TimeMap` onto the edited timeline, then to x
under the live zoom and scroll (`useOverlayLayout`, shared with the playhead diamond and
the seams). They line up in the collapsed and the full view alike; a passage cut away
entirely in the collapsed view has no width and is dropped.

The layers show while the **Surah view** preference is on, and leave Al-Fatihah out while
it is hidden.

### Tones

Neighbouring surahs (in mushaf order, Al-Fatihah aside) alternate two tones, so where one
surah ends and the next begins reads at once. Each tone is a wash and an ink, set by the
`surah-tone-*` classes in [surahs.css](../../frontend/src/features/surahs/surahs.css) from
the tokens in [tokens.css](../../frontend/src/theme/tokens.css):

```
tone   tokens                                  day                 night
a      --surah-wash-a / --surah-ink-a          gold                gold
b      --surah-wash-b / --surah-ink-b          binding green       sage green
f      --surah-wash-f / --surah-ink-f          quiet ink           quiet vellum     Al-Fatihah
sel    --surah-wash-sel / --surah-ink-sel      oxblood (accent)    vellum           the selected surah
```

A tab is its wash with an ink rule along the top edge: heavier for the selected surah,
dashed for an unsure passage.

## The Surahs column

[SurahsPanel.tsx](../../frontend/src/features/surahs/SurahsPanel.tsx) fills the right
column of the lower band (40%, beside the Silence and Cut tools).

**Header:** "Surahs", the count once there is a result (Al-Fatihah left out of it while
hidden), and, once the result holds any passages, two switches (`Switch`): **Surah view**
and **Al-Fatihah**.

**Body**, one per phase of `useSurahDetection`:

| Phase | Shows |
|---|---|
| not yet matched (`idle`) | a line on what it does, **Find surahs**, and "Runs on this computer, offline. Takes roughly N minutes for this recording." (about 0.13 minutes per minute of audio) |
| model not installed (`needs-model`) | the download prompt ("Finding surahs needs the Quran recognition model (81 MB)…") with Download, then download progress; Find surahs stays disabled until the model is on disk |
| finding (`finding`) | "Listening", a bar that fills while it transcribes ("Transcribing · m:ss of m:ss. Then a few seconds of matching."), then full on "Matching…" |
| failed (`failed`) | an error `Alert` ("Couldn't find the surahs") above the not-yet-matched body; when an earlier result exists, the `Alert` ("Couldn't find the surahs again") sits above the list instead |
| nothing recognised | "No Quran recitation was recognised in this recording.", a note on Hafs and audible recitation, and **Find again** |
| done | the list, the unsure note when any passage is unsure, and a footer "Quran model · Hafs · matched today" with **Find again** |

The button reads **Find again** once the recording has a result or a saved transcript.
Every run sends `reuse_transcript: true`, so running again repeats only the matching, which
takes seconds.

### A surah row

[SurahRow.tsx](../../frontend/src/features/surahs/SurahRow.tsx), one per surah in mushaf
order:

- the surah's number in a Rub el Hizb star medallion (filled when selected);
- its Arabic name in Amiri (`lang="ar" dir="rtl"`) over its transliteration;
- on the right, the ayah range heard ("Ayat 1–30", with "· complete" when its passages
  together cover every ayah; Al-Fatihah shows "recited N×" instead), over the passage
  count and their total length;
- an **Unsure** flag (amber) when some or all of its passages are unsure ("2 unsure").

The selected row opens below: **Keep only this surah** and **New recording…**, then a chip
per passage (its start on the edited timeline and its ayat; unsure chips dashed and marked)
that seeks there. When some passages are unsure a hint says the actions act on the sure
ones only; when all are, both actions are disabled with "Listen first: every passage of
this surah is unsure, so it can't be kept or copied." The selected row scrolls to the top
of the column however it was selected, so its actions are in view.

## Selection and stepping

[useSurahView.ts](../../frontend/src/features/surahs/useSurahView.ts):

- Selecting a surah highlights all its passages in the band, the tints and the list, and
  moves the playhead to a passage start: from the list, its first passage; from a band tab
  or a chip, that passage.
- `]` steps to the next passage start after the playhead, `[` to the previous one (more
  than a second back, so a press just after a start goes to the passage before), selecting
  its surah. Stepping goes through the passages the view shows: Al-Fatihah's are skipped
  while it is hidden, and passages cut away in the collapsed view are skipped. The keys are
  ignored while typing and with modifiers.
- Escape clears the selection (it also keeps its meaning for the cut selection).
- The selection is cleared on project change and when Al-Fatihah is hidden while selected.

## The ranges the actions use

Keep only and New recording act on the surah's accepted passages, taken out to the user's
own edits: `actionRanges` in
[surahModel.ts](../../frontend/src/features/surahs/surahModel.ts) reads the live cut ops
when the action runs. Only review cuts count: a merged cut range lying within the detected
silences is silence removal (the rule the silence list uses, `silenceOnly` in
[active.ts](../../frontend/src/features/silence/active.ts)) and is passed over, so an edge
padded into a removed pause still reaches the review cut beyond it. Where the stretch
between review cuts holding a passage's start begins earlier, at a review cut at most
`REVIEW_REACH` (20 s) before it, the start moves to that cut; the end mirrors this. This
keeps the closing words that matching clipped but the user kept while reviewing the parent
recording. An edge never moves to the file's start or end, nor to a cut that lies inside
another passage of any surah or level. An edge the user tightened needs nothing: the cuts
inside a range apply in both actions. Without review cuts near the edges the ranges are the
accepted passages as matched.

## Keep only this surah

One undoable edit, "Keep only Al-Mulk": `keepOnlyRanges` in
[cutEdl.ts](../../frontend/src/features/cuts/cutEdl.ts) cuts everything outside the
surah's ranges (merged), so several passages play back to back. A toast
announces it with **Undo** (`useUndoToast`, shared with "Remove all silence"): "Kept Al-Mulk:
its 3 passages now play back to back. Everything between them is cut." The Undo works while
the edit is still the latest one; otherwise the toast points to the transport row's Undo.

## New recording

**New recording…** opens the split dialog
([SplitModal.tsx](../../frontend/src/features/cuts/SplitModal.tsx)) with the surah's
ranges as `ranges`, titled "New recording from Al-Mulk" and named
"<recording> · Al-Mulk". With several parts it reads "A new recording will join 3 parts,
12:40 in all (edits inside applied). Everything between them is left out." The server
renders the ranges back to back into a new recording and the dialog opens its editor. The
Cut panel uses the same dialog with one range, the selection.

## Al-Fatihah and the Surah view preference

Al-Fatihah is recited in every rak'ah, so it can crowd the view. The **Al-Fatihah** switch
(`show_fatihah`) hides its tabs, tints and steps and collapses its row to one quiet line
("Al-Faatiha hidden · recited 4×"). It is visual only: the groups, the accepted ranges and
what Keep only, New recording and export act on never depend on it.

The **Surah view** switch (`surah_view`) shows or hides the band and the tints; the column
stays. A successful match turns it on, so the result shows at once.

Both are stored preferences (`stores/viewPrefs.ts`, persisted through `PATCH
/app/preferences`), on by default.

## Export chapters

The export dialog's **Add surahs as chapters** (`embed_chapters`) is checked by default when
the recording has accepted passages; checked without any, a hint says to run Find surahs
first. The backend writes each accepted passage that survives the edits as a chapter named
`Al-Mulk · 1–30` (see [../audio/04-editing-and-export.md](../audio/04-editing-and-export.md)).

## The model

One model, **Quran recognition** (`quran-base`, 81 MB), downloaded once and run offline.
Settings shows it as a single row with Download or Remove (there is no model choice), with
the Tanzil credit for the Quran text from `GET /app/info` (`quran_text_credit`) below it.
The Surahs column offers the same download where matching would start.

## Where the code lives

```
features/surahs/
  SurahsPanel.tsx       the Surahs column: header, switches, one body per phase, actions
  SurahRow.tsx          one surah: medallion, names, ayat, flags; actions and passage chips
  SurahBand.tsx         SurahBand (tabs), SurahTints (under the bars), SurahOverviewTints
  surahModel.ts         grouping per surah, tones, action ranges, visible passages (pure)
  useSurahView.ts       surah table, groups, selection with seek, [ / ] and Escape
  useSurahDetection.ts  phase machine, POST /detect/surahs, job polling, turns the view on
  surahs.css            tone classes and the tab, tint and wash styles
stores/surahStore.ts    selected surah; matching job id per project (survives leaving)
stores/viewPrefs.ts     surahView, showFatihah
components/ui/Switch.tsx
features/cuts/          keepOnlyRanges, useUndoToast, SplitModal (ranges)
features/waveform/      useOverlayLayout, WaveformView underlay, WaveformOverview overlay
```

The surah map is server state (the React Query project cache) and is never copied into a
store; `surahStore` holds only the selection and the job ids.
