# Markers & Prayer Structure

> Status: implemented. Surfaces detected phrases (takbirs) as timeline markers and turns
> them into a navigable rak'ah / position outline.

## Goal

Show where each **takbir ("Allahu Akbar")** and related phrase occurs, label the prayer
**positions** they delimit (qiyam, ruku', i'tidal, sujood, julus, tasleem), and let the
user navigate the recitation by rak'ah and position — correcting markers where the
auto-detection is wrong.

## Domain primer (for the implementing agent)

In salah, a takbir announces almost every position change. A typical rak'ah:

```
qiyam (Fatihah + surah) --takbir--> ruku' --tasmi'/takbir--> i'tidal --takbir-->
sujood --takbir--> julus --takbir--> sujood --takbir--> [next rak'ah]
```

So the ordered stream of takbirs ≈ the sequence of position boundaries. The backend's
`prayer/` model converts markers → `PrayerPosition[]`; the UI renders and lets the user
edit that interpretation. See [../audio/03-phrase-detection.md](../audio/03-phrase-detection.md).

## Data in / out

- **In:** `Marker[]` from `POST /projects/{id}/detect/phrases`
  (`{ time, label, type, confidence }`) and derived `PrayerPosition[]` from the project.
- **Out:** user edits to markers/positions (add, move, relabel, delete) persisted to the
  project. The UI is also where the user can **mark a reference takbir** to feed
  query-by-example detection (see phrase-detection doc).

## Timeline markers

- Render each `Marker` as a binding-green guide line (`--marker-line`) down through the
  bars, with a marginal note above the top rule: a small green Rub el Hizb star and the
  note (`Takbīr · sujood`) in Ibarra italic. The Arabic label is the tooltip. The selected
  marker's note takes the accent and an underline; a note that would run into the next
  one reduces to its star.
- Show confidence visually (e.g. lower opacity / dashed for low-confidence auto markers)
  so the user knows which to verify.
- Click marker → seek to it; drag → adjust time (updates state + backend); right-click /
  menu → relabel or delete.
- "Add marker at playhead" action for manual annotation.

## Prayer outline

The prayer outline (`PrayerOutline`) sits beside the tools in the editor's lower band. Its
header reads "Outline" and "Rak'ah 2 of 20" with previous/next buttons; a row of Rub el
Hizb stars, one per rak'ah, shows the current one filled, earlier ones as gold outlines
and later ones as outlines in tertiary ink; below them the current rak'ah's positions list with their
start times. The derived structure it renders:

```
Rak'ah 1
  qiyam        0:00 – 1:12   (Fatihah + Al-Ikhlas)
  ruku'        1:12 – 1:28
  i'tidal      1:28 – 1:35
  sujood       1:35 – 1:50
  julus        1:50 – 1:54
  sujood       1:54 – 2:09
Rak'ah 2
  ...
Tasleem        ...
```

- Click any position → seek there; a star seeks to its rak'ah; `[` / `]` step rak'ahs;
  the current position highlights as audio plays.
- Allow the user to **correct** the structure: reassign a marker's position type,
  insert/remove a boundary, set rak'ah counts. The state model should make positions a
  function of markers + manual overrides.
- Surface mismatches (e.g. detected takbirs don't match an expected rak'ah count) as a
  gentle `Alert`, not a hard error — recitations vary (qunut, sajdah tilawah, etc.).

## Reference-clip workflow (closing the detection loop)

- Let the user select a region containing a clean takbir and "Use as reference" →
  send to `detect/phrases` as a reference clip for query-by-example. This adapts
  detection to the specific reciter and improves marker accuracy.

## Relationship to silence editing

Markers and silence regions coexist on the same waveform. Keep them visually distinct
(silences = ink bands; cuts = hatched; markers = green lines + marginal notes). Editing silence (cuts)
shifts the timeline — decide and document how markers/positions are remapped after a
render (the backend should recompute or offset marker times relative to the EDL).
