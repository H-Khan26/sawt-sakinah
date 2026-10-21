# Surah Recognition

> Status: implemented (`detection/transcribe.py`, `detection/quran.py`,
> `detection/surahs.py`). Transcribes the recitation and matches the words against the
> Quran text to find which surahs and ayat are recited, and where.

## Goal

Find every continuous passage of Quran recitation in a recording and say which surah and
which ayat it is, with start and end times, **as data**. The editor tints the passages on
the waveform so the user can select, keep or split off a surah; export can write the
accepted passages as chapters. Recognition never cuts or writes audio.

The answer has to be right more than it has to be tight. A passage labelled with the
wrong surah misleads the user; an edge that sits a second into the pause costs nothing,
because the user cuts and listens before exporting. The thresholds below are set for
precision, and edges are padded outward on purpose.

## Output contract

```
SurahPassage:
  surah       int      # 1..114
  ayah_from   int      # first ayah heard (1-based, inclusive)
  ayah_to     int      # last ayah heard (inclusive)
  start       float    # seconds, padded into the pause before the passage
  end         float    # seconds, padded into the pause after it
  confidence  float    # matched transcript words / transcript words the passage spans (0..1)
  level       str      # "accept" | "unsure"

SurahMap:
  model       str        # catalog id of the Whisper model the transcript came from
  matched_at  datetime   # when matching ran (UTC)
  passages    list[SurahPassage]   # ordered by start

transcribe(audio, *, speech_spans, ...) -> list[Word]
match_surahs(words, *, speech_spans, total_duration, ...) -> list[SurahPassage]
```

`Project.surahs` holds the `SurahMap` (`None` until recognition has run). Rejected
stretches are not reported; the gaps between passages are simply unlabelled.

## Pipeline

```
working copy (16 kHz WAV) + speech map spans
        |
        v
  transcribe.py   speech spans -> padded clips -> one packed stream -> Whisper
                  -> words (normalized, source time)  --> audio/transcript.json
        |
        v
  surahs.py       anchor on three-word sequences -> follow the mushaf -> score
                  -> classify -> merge runs -> snap edges
        |                                   ^
        v                                   |
  SurahMap -> project.json          quran.py (Tanzil text, normalized, indexed)
```

Transcription is the slow step; matching is a pure function of the transcript and
runs in under a second, so it can be re-run on the saved transcript after a threshold change.

## Inputs

- **The working copy** (`AudioSource.working_copy`, 16 kHz mono WAV), or the mp3 when
  there is none.
- **The speech map spans** (`SpeechMap.spans()`, the fine Silero speech spans; see
  [02-silence-detection.md](02-silence-detection.md)). They decide what audio is
  transcribed and where passage edges snap. The worker computes the speech map if the
  source lacks one. Without it (no `vad` extra, no working copy) the whole file is
  transcribed with Whisper's built-in VAD and edges are only padded.

## Transcription (`detection/transcribe.py`)

### The model

One model, `quran-base` (`surahs.model`), from the `whisper_models` catalog: an int8
CTranslate2 conversion of
[tarteel-ai/whisper-base-ar-quran](https://huggingface.co/tarteel-ai/whisper-base-ar-quran)
(a Whisper base fine-tuned on Quran recitation, Apache-2.0; Whisper itself is MIT). It
is about 80 MB (`size_mb: 81`), is not bundled, and is downloaded once from the Hugging
Face Hub at a pinned commit (`whisper_models.quran-base.revision`), so a re-upload can't
change it silently. Downloads resume after an interruption and every file is checked
against the repo's hash before it is used (`detection/whisper_models.py`). After that the
model is loaded from its local directory with `local_files_only`; recognition never
contacts the Hub. The loaded model is cached across jobs (one model at a time).

It runs on the CPU (`transcription.device: cpu`, `compute_type: int8`,
`language: ar`, `beam_size: 5`; a beam of 1 decodes greedily in about half the time at a
small cost in recall). No initial prompt is given: the model is a Quran fine-tune and
transcribes recitation as it is.

### Clips from the speech map

With speech spans, only speech is transcribed:

1. Spans closer than `transcription.clip_merge_gap` (1.0 s) merge into one clip, so a
   phrase split by a short breath is decoded together.
2. Each clip is padded by `transcription.clip_pad` (0.3 s) of context, clamped to the
   file, and clips the padding made overlap merge again.
3. The clip audio is decoded and **concatenated into one stream**, which Whisper
   transcribes with its own VAD off (the clips already are the speech). Whisper's
   encoder always processes 30 s windows; isolated short clips would each pay for a
   full window, while one packed stream is decoded in as few windows as the speech
   needs.

Without spans the whole file goes to Whisper with `transcription.vad_filter`.

### Words on the source timeline

Whisper runs with word timestamps. Each word time in the packed stream is mapped back to
source time through the clip offset table: the clip is chosen by the word's midpoint and
both edges are clamped to that clip, so a word Whisper places across a seam can't
straddle two distant source regions. Every word is normalized with
`_arabic.arabic_words` (below); a Whisper word that holds several normalized words is
split into words sharing its times, and one with no Arabic letters left is dropped. Each
`Word` keeps `text` (normalized), `start`, `end`, `probability` and `raw` (Whisper's
diacritised spelling).

Progress is reported as `{"stage": "transcribing", "done_sec", "total_sec"}` as each
segment is decoded, in seconds of the audio handed to Whisper (the packed clips, or the
whole file).

## The transcript sidecar

A finished transcription is saved before matching, as `audio/transcript.json` in the
project (`AudioSource.transcript`):

```
{"model": "quran-base", "words": [[text, start, end, probability, raw], ...]}
```

It is written atomically. A detection with `reuse_transcript: true` (the default) matches
the saved words again instead of transcribing, when the sidecar exists, reads cleanly and
came from the current model. Otherwise (no sidecar, another model, unreadable, or
`reuse_transcript: false`) the recording is transcribed anew and the sidecar replaced.
The store nulls `transcript` when the file is missing, and the wire exposes only
`has_transcript`.

## The Quran text (`detection/quran.py`)

The text is Tanzil's **Simple Clean** edition (Hafs, version 1.1), one
`surah|ayah|text` line per ayah, vendored verbatim in
`detection/assets/quran-simple-clean.txt` with Tanzil's copyright block.
`quran-surahs.json` holds the per-surah metadata (number, Arabic name, transliteration
`tname`, English meaning, ayah count, Meccan/Medinan) selected from Tanzil's
`quran-data.xml`. Both are used under Tanzil's terms (CC BY 3.0, no changes to the text,
the source credited with a link); `assets/TANZIL_LICENSE` records the provenance and the
terms, and the app shows the credit line from `GET /app/info` (`quran_text_credit`).

On first use the text is loaded once per process:

- Every ayah goes through the same `arabic_words` normalization as the transcript.
- The basmala that heads ayah 1 of every surah except Al-Fatihah and At-Tawbah is
  removed: in Hafs it is not part of the ayah, and a recited basmala stays outside every
  passage (step 7). Al-Fatihah's basmala is its first ayah and stays.
- The result is one flat list of about 77,800 words in mushaf order, each tagged with
  its surah and ayah, plus the index one past each surah's last word.
- Every three-word sequence that doesn't cross a surah boundary is indexed to the
  positions where it starts.

### Normalization (`detection/_arabic.py`)

Both sides are reduced to bare letters before comparison: harakat, tanwin, sukun,
shadda, the superscript alef and tatweel are stripped; alef forms (hamza above/below,
madda, wasla) fold to a bare alef; ى becomes ي, ة becomes ه, ؤ becomes و, ئ becomes ي, and
a standalone hamza is dropped. Any other non-letter (Quranic marks, punctuation, digits)
separates words.

## Matching (`detection/surahs.py`)

`match_surahs` walks the transcript from the start. All thresholds come from the
`surahs:` config section.

1. **Normalise.** Transcript and Quran words are already in the normalized form above.
2. **Anchor.** Each three-word sequence of the transcript is looked up in the Quran's
   index; every exact hit is a candidate placement (a seed). A sequence found more than
   `anchor_max_hits` (64) times seeds nothing; the walk from a rarer neighbouring
   sequence covers it.
3. **Follow.** From a seed the matcher walks forward through transcript and mushaf word
   by word, and backward from the word before the seed, within the seed's surah. A word
   matches when its RapidFuzz ratio against the Quran word reaches `word_match` (80);
   one transcript word may also match two Quran words written together, or two
   transcript words one Quran word. At a mismatch the walk tries stepping over up to
   `max_skip` (3) transcript words (extra speech, a misheard word) and/or Quran words
   (words the model missed), cheapest first, and continues only where the following
   words match too (unless the landing word is the surah's last). Otherwise the walk
   ends at its last match: the speech stopped matching (a takbir, Amin, the adhkar) or
   the surah ended. A walk never crosses a pause longer than `max_pause` (20 s) between
   transcript words, so the rak'ahs of a surah read across a prayer become separate
   passages.
4. **Resolve repeats.** A seed with several placements (a refrain, a phrase shared
   between surahs) walks each one. Among the walks within 80 % of the longest, one that
   continues the last accepted passage of its surah wins, then the longest, then the
   earliest in the mushaf.
5. **Score.** A walk counts its matched transcript words and its match ratio (matched
   over all transcript words it spans; this is the passage's `confidence`). Its margin
   is how far it beats the best walk placed in a different surah over the same stretch
   of transcript: `1 - other / matched` (1 when no other surah matches there).
6. **Classify** into `accept`, `unsure` or rejected (next section). Accepted and unsure
   walks become passages and the matcher continues after them; after a rejected seed it
   moves on one word.
7. **Emit passages.**
   - *Start.* A passage starts at its first matched ayah word. A basmala recited before
     it is left outside it, like the takbir and Amin, matching the editing rule that a
     surah begins at its first ayah. Al-Fatihah from ayah 1 starts at its basmala, which
     is its first ayah.
   - *Merge runs.* Consecutive passages of one surah that follow on in the mushaf (the
     next starts between the last one's final ayah, less one, and the ayah after next,
     allowing for an ayah the model missed) with at most `max_pause`
     between them merge into one passage at the higher of their levels; this rejoins a
     walk broken by a stretch the model missed.
   - *Edges.* Each start moves to the start of the speech span it falls in, then
     `edge_pad` (1.0 s) earlier into the pause, but never before the end of the previous
     speech span; ends mirror this. Without speech spans the word times are only padded.
     Edges are clamped to the file, never move inward past the passage's own words, and
     neighbouring passages that would overlap meet halfway between their words. A cut at
     a passage edge therefore never clips a word.

Cost: the Quran index is built once (a fraction of a second); a walk costs a few fuzzy
comparisons per word, so the transcript of an hour of recitation (a few thousand words)
is matched in under a second.

## Levels: accept, unsure, reject

| Level | Needs |
|---|---|
| `accept` | at least `accept_min_words` (12) matched words, ratio at least `accept_min_ratio` (0.70) and margin at least `accept_min_margin` (0.25) |
| `unsure` | at least `unsure_min_words` (8) matched words and ratio at least `unsure_min_ratio` (0.55) |
| rejected | anything below; not reported |

Three rules adjust this:

- **Whole short surah.** A walk that runs from the first word of its surah to the last
  needs only `unsure_min_words` matched words to be accepted (Al-Kawthar is ten words);
  the ratio and margin bars still apply.
- **Continuity promotion.** A walk that picks up where the last accepted passage of the
  same surah stopped (its first ayah within one of that passage's last ayah) is promoted
  one level, from rejected to unsure or from unsure to accept, if it has at least
  `promote_min_words` (4) matched words at the unsure ratio. This joins a surah read on
  across rak'ahs, or resumed after a pause, without lowering the bar for a passage that
  stands alone.
- **Quoted in speech.** A walk that doesn't continue an accepted passage is rejected
  when more than `context_max_words` (10) other transcript words (not part of an earlier
  passage, nor a basmala recited right before it) fall in the `context_window` (15 s)
  before it. That is Quran quoted inside other speech, such as a du'a that ends with the
  last ayat of Al-Baqarah; recitation in salah follows a takbir and a pause, not a stream
  of words.

`accept` passages are shown as recognised and are the only ones written as chapters on
export. `unsure` passages are shown flagged, for the user to listen to before acting on
them. The margin is what keeps a passage from being accepted when the same words also
fit another surah about as well.

## Job and endpoint

`POST /projects/{id}/detect/surahs` with body `{"reuse_transcript": true}` (the default)
answers 202 `{job_id}` and queues a `detect_surahs` job on the dedicated `transcription`
pool (`service.transcription_workers`, 1 by default, since concurrent Whisper on one
device runs out of memory). The model and thresholds come from the config, not the
request. If the model isn't downloaded the request answers 409 `ModelNotInstalledError`
instead of queueing a job that can only fail; the model is held as in use from the
request until the job ends, so it can't be deleted meanwhile.

The job (`service/workers.py::surahs_worker`) reports, in order:

```
{"stage": "detect", "status": "start"}
{"stage": "transcribing", "done_sec": 12.5, "total_sec": 1830.2}   # repeated; skipped when the transcript is reused
{"stage": "matching"}
{"stage": "detect", "status": "done"}
```

It saves the transcript sidecar (when it transcribed), stores the `SurahMap` as
`Project.surahs`, sets `status.analyzed`, and returns
`{"passages": n, "accept": a, "unsure": u}`. `GET /quran/surahs` lists the 114 surahs
(`number`, `name`, `tname`, `ename`, `ayas`, `type`) for labelling passages.

## Parameters

`transcription:` — `device`, `compute_type`, `language`, `beam_size`, `vad_filter` (only without
speech spans), `clip_merge_gap`, `clip_pad`.

`surahs:` — `model`, `word_match`, `accept_min_words`, `accept_min_ratio`,
`accept_min_margin`, `unsure_min_words`, `unsure_min_ratio`, `promote_min_words`,
`max_skip`, `max_pause`, `anchor_max_hits`, `context_window`, `context_max_words`,
`edge_pad`. The retired `basmala_max_gap` is still accepted in a user `config.yaml` and
ignored.

`whisper_models:` — the catalog (`label`, `description`, `repo`, `revision`, `size_mb`);
only these ids are accepted anywhere.

## Limitations

- **Hafs only.** The text is the Hafs reading and the model was trained on it; other
  qira'at differ in wording and will match worse or not at all.
- **Recitation in salah assumed.** Quran heard inside a stream of other speech (a du'a,
  a talk) is rejected by the context rule, so a recording of a lecture that quotes ayat
  will mostly stay unlabelled.
- **Continuous reading assumed.** A walk follows the mushaf forward. A reciter who
  repeats an ayah, jumps back, or reads ayat out of order produces several shorter
  passages (or rejected stretches) rather than one.
- **Uncalibrated thresholds.** The `surahs:` values are reasoned defaults, not yet
  calibrated on a labelled set of recordings; expect them to change as more recordings
  are tested.
- **Short passages are hard.** Below `unsure_min_words` matched words a passage is not
  reported unless it continues an accepted one, so a very short surah read with errors,
  or a few ayat, may go unlabelled.
- **Edges are generous by design**, padded into the pause; they are not word-accurate
  boundaries.

## Boundary

`detection/transcribe.py` reads audio and returns words; `detection/surahs.py` is a pure
function from words to `list[SurahPassage]`. Neither writes audio. The worker persists
the transcript sidecar and the `SurahMap`; using passages as selections, keeps or
chapters is the editor's and the export's job
([04-editing-and-export.md](04-editing-and-export.md)).
