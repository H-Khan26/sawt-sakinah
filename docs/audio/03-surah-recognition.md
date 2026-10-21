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
  transcribe.py   speech spans -> padded clips -> packed stream(s) -> Whisper
                  -> words (normalized, source time)  --> audio/transcript.json
        |
        v
  surahs.py       retime words -> anchor on three-word sequences -> follow the
                  mushaf -> score -> classify -> trim -> merge runs -> snap edges
        |                                   ^
        v                                   |
  SurahMap -> project.json          quran.py (Tanzil text, normalized, indexed)
```

Transcription is the slow step; matching is a pure function of the transcript and the
speech spans and runs in under a second, so it can be re-run on the saved transcript
after a threshold change.

## Inputs

- **The working copy** (`AudioSource.working_copy`, 16 kHz mono WAV), or the mp3 when
  there is none.
- **The speech map spans** (`SpeechMap.spans()`, the fine Silero speech spans, built
  here with `surahs.bridge_gap` (0.5 s) so speech runs closer than that are one span, a
  wider bridge than the `segmentation.bridge_gap` (0.2 s) silence detection uses, so a
  held last word that dips mid-way stays one span; see
  [02-silence-detection.md](02-silence-detection.md)). They decide what audio is
  transcribed, how much silence lies between two words, and where passage edges snap.
  The worker computes the speech map if the source lacks one. Without it (no `vad`
  extra, no working copy) the whole file is transcribed with Whisper's built-in VAD, a
  pause is the plain time between words, and edges are only padded.

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
small cost in recall). With `condition_on_previous_text: true` Whisper sees the previous
window's text while decoding the next. No initial prompt is given: the model is a Quran
fine-tune and transcribes recitation as it is.

### Clips from the speech map

With speech spans, only speech is transcribed:

1. Spans closer than `transcription.clip_merge_gap` (1.0 s) merge into one clip, so a
   phrase split by a short breath is decoded together.
2. Each clip is padded by `transcription.clip_pad` (0.3 s) of context, clamped to the
   file, and clips the padding made overlap merge again.
3. The clip audio is decoded and **concatenated into one stream**, with
   `transcription.clip_gap` (0.0 s) of silence between clips, which Whisper transcribes
   with its own VAD off (the clips already are the speech). Whisper's encoder always
   processes 30 s windows; isolated short clips would each pay for a full window, while
   one packed stream is decoded in as few windows as the speech needs.
4. With `transcription.window_reset` above 0, a clip at least that many seconds long
   (a recitation, not a takbir) starts a new stream (`_clip_groups`). Each stream is a
   separate Whisper run, so that clip begins at the start of a fresh window instead of
   partway through one that opened on earlier clips. The default, 0, packs every clip
   into one stream.

Without spans the whole file goes to Whisper with `transcription.vad_filter`.

### Words on the source timeline

Whisper runs with word timestamps. Each word time in a packed stream is mapped back to
source time through the stream's clip offset table: the clip is chosen by the word's
midpoint and both edges are clamped to that clip, so a word Whisper places across a seam
can't straddle two distant source regions. Every word is normalized with
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
`surahs:` config section. Two notions run through the steps:

- **Silence.** A pause between two words is the silence between them: the seconds the
  speech spans hold no speech, from the earlier word's end to the later one's start
  (the whole gap without spans). Speech the model didn't transcribe, such as quiet
  dhikr or a stretch it skipped, is not a pause.
- **Walls.** The prayer's own phrases, the takbir (الله اكبر), the tasmi'
  (سمع الله لمن حمده) and the tahmid (ربنا لك الحمد, ربنا ولك الحمد), each word matched
  against `word_match`, are walls: no seed starts on one and no walk includes or crosses
  one, so a takbir after a surah's last word can't be taken for the next ayah's الله.

1. **Normalise.** Transcript and Quran words are already in the normalized form above.
   A word whose times take in a pause of `word_gap` (1.0 s) or more is the alignment
   smearing it over a neighbouring clip, not a long word; before matching, its times
   are cut at the longest such pause and kept on the side holding more of its speech, so
   a passage's first word doesn't start in the Amin or takbir before it, nor its last
   word end in the takbir after it.
2. **Anchor.** Each three-word sequence of the transcript is looked up in the Quran's
   index; every exact hit is a candidate placement (a seed). A sequence found more than
   `anchor_max_hits` (64) times seeds nothing; the walk from a rarer neighbouring
   sequence covers it.
3. **Follow.** From a seed the matcher walks forward through transcript and mushaf word
   by word, and backward from the word before the seed, within the seed's surah and the
   seed's run of transcript words. A run ends at a wall and wherever more than
   `max_pause` (5 s) of silence lies between neighbouring words, so the ruku' and sujud
   between the rak'ahs of a surah read across a prayer end a walk. A word matches when
   its RapidFuzz ratio against the Quran word reaches `word_match` (80); one transcript
   word may also match two Quran words written together, or two transcript words one
   Quran word. At a mismatch the walk tries stepping over up to `max_skip` (8)
   transcript words (extra speech, a misheard word) and/or Quran words (words the model
   missed), cheapest first. A step over transcript words never spans more than
   `max_pause` of silence in all: skipped words stand for misheard speech, not a pause.
   The walk continues only where the next words after the landing match too; only a
   landing on the surah's edge (its last word, or its first walking backward), with
   nothing beyond it to confirm with, is taken unconfirmed, so a stray word at the edge
   of the run (a takbir, or a scrap of one) can't pull the walk out to it. Otherwise the
   walk ends at its last match: the speech stopped matching (Amin, the adhkar) or the
   surah ended.
4. **Resolve repeats.** A seed with several placements (a refrain, a phrase shared
   between surahs) walks each one. Among the walks within 80 % of the longest, one that
   resumes the last accepted passage of its surah (see *Continuity promotion* below)
   wins, then the longest, then the earliest in the mushaf.
5. **Score.** A walk counts its matched transcript words and its match ratio (matched
   over all transcript words it spans; this is the passage's `confidence`). Its margin
   is how far it beats the best walk placed in a different surah over the same stretch
   of transcript: `1 - other / matched` (1 when no other surah matches there).
6. **Classify** into `accept`, `unsure` or rejected (next section). Accepted and unsure
   walks become passages and the matcher continues after them; after a rejected seed it
   moves on one word.
7. **Emit passages.**
   - *Trim edges.* As a walk becomes a passage, a first or last group of at most
     `edge_trim_words` (1) transcript words that stands at least `edge_trim_pause`
     (1.5 s) of silence apart from the rest of the walk, while its ayah runs on across
     that pause, is dropped: nobody pauses that long inside an ayah's opening or closing
     words, so the group is a takbir or Amin misheard as those words, or their times
     smeared onto it. A first group that ends its ayah (a lone الم), or a last group
     that begins one, stays. The passage's ayat and confidence come from the trimmed
     walk, and dropped words at its end are free for the next walk.
   - *Start.* A passage starts at its first matched ayah word. A basmala recited before
     it is left outside it, like the takbir and Amin, matching the editing rule that a
     surah begins at its first ayah. Al-Fatihah from ayah 1 starts at its basmala, which
     is its first ayah.
   - *Merge runs.* Consecutive passages of one surah where the next resumes the last
     (the rule under *Continuity promotion* below) with at most `merge_max_pause`
     (20 s) of silence between them merge into one passage at the higher of their
     levels; this rejoins a walk broken by a stretch the model missed or garbled, by a
     pause, or by the reciter going back an ayah to resume.
   - *Edges.* Each start moves to the start of the speech span it falls in, or of the
     next span when it falls in a pause (speech doesn't start in silence), then
     `edge_pad` (1.0 s) earlier into the pause, but never before the end of the span
     before. Each end moves to the end of the span it falls in, or of the previous span
     when it falls in a pause, then `edge_pad` later, but never past the start of the
     next span. A cut at a passage edge therefore lands in a pause and doesn't clip the
     passage's speech, while an edge can move inward past a word timed into a pause.
     Without speech spans the word times are only padded. Edges are clamped to the file,
     and neighbouring passages that would overlap meet halfway between their words.

Cost: the Quran index is built once (a fraction of a second); a walk costs a few fuzzy
comparisons per word, so the transcript of an hour of recitation (a few thousand words)
is matched in under a second.

## Levels: accept, unsure, reject

| Level | Needs |
|---|---|
| `accept` | at least `accept_min_words` (12) matched words, ratio at least `accept_min_ratio` (0.70) and margin at least `accept_min_margin` (0.25) |
| `unsure` | at least `unsure_min_words` (8) matched words and ratio at least `unsure_min_ratio` (0.55) |
| rejected | anything below; not reported |

Four rules adjust this:

- **Whole short surah.** A walk that runs from the first word of its surah to the last
  needs only `unsure_min_words` matched words to be accepted (Al-Kawthar is ten words);
  the ratio and margin bars still apply.
- **Continuity promotion.** A walk that resumes the last accepted passage of the same
  surah is promoted one level, from rejected to unsure or from unsure to accept, if it
  has at least `promote_min_words` (4) matched words at the unsure ratio. It resumes it
  when its first Quran word lies anywhere from the start of the ayah before that
  passage's last ayah (the reciter went back an ayah to resume) to `resume_max_words`
  (25) words past the word after that passage's last (the model missed or garbled a
  stretch). This joins a surah read on across rak'ahs, or resumed after a pause, without
  lowering the bar for a passage that stands alone.
- **Quoted in speech.** A walk that doesn't resume an accepted passage is rejected when
  more than `context_max_words` (10) other transcript words (not part of an earlier
  passage) run on into it, or into a basmala recited right before it. Counting goes back
  word by word and stops at more than `context_gap` (2 s) of silence between two words,
  or at words starting more than `context_window` (15 s) before the walk (or its
  basmala). That is Quran quoted inside other speech, such as a du'a that ends with the
  last ayat of Al-Baqarah; recitation in salah follows a takbir and a pause, not a stream
  of words.
- **A new surah follows a pause.** A walk placed in a different surah from the last
  passage (accepted or unsure) is rejected when less than `surah_min_pause` (1 s) of
  silence lies between that passage's end and the walk's first word. A surah starts
  after a pause (the Amin, a takbir, a basmala); words of another surah running straight
  on from the last passage are its alignment spilling over that passage's end.

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

Defaults in parentheses; times are in seconds.

`transcription:` — `device` (`cpu`), `compute_type` (`int8`), `language` (`ar`),
`beam_size` (5), `vad_filter` (true; only without speech spans), `clip_merge_gap` (1.0),
`clip_pad` (0.3), `clip_gap` (0.0), `condition_on_previous_text` (true), `window_reset`
(0.0, one stream).

`surahs:` — `model` (`quran-base`), `bridge_gap` (0.5), `word_match` (80), `accept_min_words` (12),
`accept_min_ratio` (0.70), `accept_min_margin` (0.25), `unsure_min_words` (8),
`unsure_min_ratio` (0.55), `promote_min_words` (4), `max_skip` (8), `max_pause` (5.0),
`anchor_max_hits` (64), `context_window` (15.0), `context_max_words` (10), `context_gap`
(2.0), `resume_max_words` (25), `merge_max_pause` (20.0), `surah_min_pause` (1.0),
`word_gap` (1.0), `edge_trim_pause` (1.5), `edge_trim_words` (1), `edge_pad` (1.0). The
retired `basmala_max_gap` is still accepted in a user `config.yaml` and ignored.

`whisper_models:` — the catalog (`label`, `description`, `repo`, `revision`, `size_mb`);
only these ids are accepted anywhere.

## Tuning against reviewed recordings

`scripts/tune_surahs.py` runs the matcher on recordings already edited by hand and
scores its passages against that edit. Each case is a directory
`~/sawt-tuning/cases/<slug>/` (`--cases` names another root; a directory starting with
`_` is skipped unless named with `--case`) holding the reviewed project's
`project.json`, `transcript.json`, `source.speech.npz` and `source.work.wav`. The
project's cuts are the review, since everything that isn't recitation is cut: the kept
regions, the file minus the merged cuts, are the truth, each a stretch of recitation
with about a second of air at each edge. Scoring measures at each region edge the
clipped speech (the region's speech left outside the passage), the absorbed speech
(another kept region's taken in), the leaked speech (cut speech taken in) and the air
kept beside the speech, and counts missed regions and spurious or mixed passages, all
weighed into one cost. Speech is always measured with fixed spans (the speech map at
fixed segmentation settings), so a setting can't score better by seeing less speech.
`--set section.key=value` overrides a `surahs.*` or `segmentation.*` knob for one run
(`transcribe` takes `transcription.*` and `segmentation.*`) on top of the base defaults
file, without touching any config.

- `truth` prints each case's kept regions and their speech edges.
- `score` matches each case's transcript and scores the passages, drilling into the
  worst edges (`--worst`).
- `sweep` scores a grid of settings (`--grid section.key=v1,v2`), as the full product or
  one knob at a time from the base (`--coordinate`).
- `edges` shows the words, spans and edges around a time point (`--at`).
- `transcribe` writes a transcript variant (`transcripts/NAME.json` and
  `NAME.meta.json`), which `score`, `sweep` and `edges` read with `--transcript NAME`.

```
.venv/Scripts/python scripts/tune_surahs.py score --worst 12
.venv/Scripts/python scripts/tune_surahs.py sweep --grid surahs.edge_pad=0.5,1.0 --top 8
.venv/Scripts/python scripts/tune_surahs.py edges --case anbiya-luqman --at 404
.venv/Scripts/python scripts/tune_surahs.py transcribe --variant beam1 --set transcription.beam_size=1 --case anbiya-luqman
```

## Limitations

- **Hafs only.** The text is the Hafs reading and the model was trained on it; other
  qira'at differ in wording and will match worse or not at all.
- **Recitation in salah assumed.** Quran heard inside a stream of other speech (a du'a,
  a talk) is rejected by the context rule, so a recording of a lecture that quotes ayat
  will mostly stay unlabelled.
- **Continuous reading assumed.** A walk follows the mushaf forward. Going back an ayah
  to resume can be joined into one passage (*Merge runs*), but a reciter who jumps back
  further or reads ayat out of order produces several shorter passages (or rejected
  stretches) rather than one.
- **The takbir is a wall even inside an ayah.** الله اكبر also occurs in 9:72, 29:45
  and 40:10; a walk breaks there, and the two parts are rejoined only when both are
  reported and merge.
- **Few reviewed recordings.** The `surahs:` values have no broad labelled set behind
  them; `scripts/tune_surahs.py` scores them against the reviewed recordings at hand.
  Expect them to change as more recordings are tested.
- **Short passages are hard.** Below `unsure_min_words` matched words a passage is not
  reported unless it resumes an accepted one, so a very short surah read with errors,
  or a few ayat, may go unlabelled.
- **Edges are generous by design**, padded into the pause; they are not word-accurate
  boundaries.

## Boundary

`detection/transcribe.py` reads audio and returns words; `detection/surahs.py` is a pure
function from words to `list[SurahPassage]`. Neither writes audio. The worker persists
the transcript sidecar and the `SurahMap`; using passages as selections, keeps or
chapters is the editor's and the export's job
([04-editing-and-export.md](04-editing-and-export.md)).
