/**
 * The Surahs column beside the tools: which surahs the recording holds, and the actions on them.
 *
 * A header ("Surahs", the count, and the Surah view and Al-Fatihah switches), then one body per
 * matching phase (see `useSurahDetection`): the invitation to find surahs, the model download,
 * the progress while it transcribes and matches, a failure with a retry, nothing recognised, or
 * the list of surahs in mushaf order with "Find again" at its foot. The count leaves Al-Fatihah
 * out while it is hidden.
 *
 * "Keep only this surah" is one undoable edit that cuts everything outside the surah's accepted
 * passages, announced by a toast with Undo; "New recording…" opens the split sheet with those
 * passages, joined, named "<recording> · <surah>". Both take each passage out to the user's own
 * cuts where the audio they kept runs past it (`actionRanges`), so a reviewed edge that reaches
 * further than matching did is kept. Neither depends on the Al-Fatihah switch.
 */
import { Alert, Button, Progress, Switch } from "@/components/ui";
import { SplitModal } from "@/features/cuts/SplitModal";
import { keepOnlyRanges } from "@/features/cuts/cutEdl";
import { useEdlEditor } from "@/features/cuts/useEdlEditor";
import { useUndoToast } from "@/features/cuts/useUndoToast";
import { ColumnHeading } from "@/features/editor/ColumnHeading";
import { ModelDownloadPrompt } from "@/features/models/ModelDownload";
import type { Span } from "@/lib/edl";
import { formatRelativeTime, plural } from "@/lib/format";
import { formatHms } from "@/lib/time";
import { useSurahStore } from "@/stores/surahStore";
import { useViewPrefs } from "@/stores/viewPrefs";
import type { EditOperation, ProjectView } from "@/types/api";
import { type ReactNode, useState } from "react";
import { SurahRow, UnsureFlag } from "./SurahRow";
import { FATIHAH, type SurahGroup, actionRanges, surahName } from "./surahModel";
import { type SurahDetection, surahJobProgress, useSurahDetection } from "./useSurahDetection";
import { useHiddenFatihahDeselect, useSelectSurah, useSurahGroups } from "./useSurahView";

/** Rough minutes of matching per minute of audio on a laptop CPU, for the estimate. */
const MATCH_MINUTES_PER_MINUTE = 0.13;

function Header({ count, showSwitches }: { count: number | null; showSwitches: boolean }) {
  const surahView = useViewPrefs((s) => s.surahView);
  const setSurahView = useViewPrefs((s) => s.setSurahView);
  const showFatihah = useViewPrefs((s) => s.showFatihah);
  const setShowFatihah = useViewPrefs((s) => s.setShowFatihah);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <ColumnHeading>Surahs</ColumnHeading>
      {count !== null && (
        <span className="whitespace-nowrap font-display text-[12px] uppercase tracking-[0.26em] text-text-secondary">
          {plural(count, "surah", "surahs")}
        </span>
      )}
      {showSwitches && (
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          <Switch checked={surahView} onChange={setSurahView}>
            Surah view
          </Switch>
          <Switch checked={showFatihah} onChange={setShowFatihah}>
            Al-Fatihah
          </Switch>
        </span>
      )}
    </div>
  );
}

/** The find button: "Find again" once the recording has been matched or transcribed. */
function FindButton({
  detection,
  again,
  variant = "primary",
}: {
  detection: SurahDetection;
  again: boolean;
  variant?: "primary" | "secondary" | "ghost";
}) {
  const needsModel = detection.phase === "needs-model" || detection.model?.installed === false;
  return (
    <Button
      size="sm"
      variant={variant}
      onClick={detection.run}
      loading={detection.phase === "finding"}
      disabled={needsModel}
      title={needsModel ? "Download the Quran recognition model first" : undefined}
    >
      {again ? "Find again" : "Find surahs"}
    </Button>
  );
}

function Finding({ detection }: { detection: SurahDetection }) {
  const { fraction, text } = surahJobProgress(detection.job, formatHms);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text-secondary">Listening</p>
      <Progress value={fraction} label="Finding surahs" />
      <p className="text-xs tabular-nums text-text-tertiary">{text}</p>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-text-tertiary">{children}</p>;
}

export function SurahsPanel({ project }: { project: ProjectView }) {
  const detection = useSurahDetection(project);
  const { passages, groups, infos } = useSurahGroups(project);
  const showFatihah = useViewPrefs((s) => s.showFatihah);
  const selected = useSurahStore((s) => s.selected);
  const selectSurah = useSelectSurah(project);
  const editor = useEdlEditor(project.id);
  const undoToast = useUndoToast(project.id);
  const [splitFor, setSplitFor] = useState<{ group: SurahGroup; ranges: Span[] } | null>(null);
  useHiddenFatihahDeselect();

  const { phase } = detection;
  const again = project.surahs !== null || project.audio_source.has_transcript;
  const shown = groups.filter((g) => showFatihah || g.surah !== FATIHAH);
  const anyUnsure = groups.some((g) => g.accepted.length < g.passages.length);

  const duration = project.audio_source.duration_sec;
  const rangesFor = (group: SurahGroup, ops: EditOperation[]) =>
    actionRanges(group, passages, ops, duration, project.silences);

  const keepOnly = (group: SurahGroup) => {
    const name = surahName(group.surah, infos);
    const parts = group.accepted.length;
    const edit = editor.apply(
      (ops) => keepOnlyRanges(ops, rangesFor(group, ops), duration),
      `Keep only ${name}`,
    );
    if (!edit) return;
    undoToast(
      parts > 1
        ? `Kept ${name}: its ${parts} passages now play back to back. Everything between them is cut.`
        : `Kept ${name}. Everything around it is cut.`,
      edit,
    );
  };

  let body: ReactNode;
  if (phase === "loading") {
    body = null;
  } else if (phase === "finding") {
    body = <Finding detection={detection} />;
  } else if (phase === "needs-model") {
    body = (
      <div className="flex flex-col gap-3">
        {detection.model ? (
          <ModelDownloadPrompt model={detection.model} />
        ) : (
          <p className="text-sm text-text-secondary">
            Finding surahs needs the Quran recognition model. Download it from Settings.
          </p>
        )}
        <div>
          <FindButton detection={detection} again={again} variant="secondary" />
        </div>
      </div>
    );
  } else if (phase === "idle" || (phase === "failed" && !project.surahs)) {
    const minutes = Math.max(
      1,
      Math.round((project.audio_source.duration_sec / 60) * MATCH_MINUTES_PER_MINUTE),
    );
    body = (
      <div className="flex flex-col items-start gap-3">
        {phase === "failed" && (
          <Alert variant="error" title="Couldn't find the surahs" className="self-stretch">
            {detection.error}
          </Alert>
        )}
        <p className="text-sm text-text-secondary">
          Find which surahs are recited in this recording and where each one starts and ends.
        </p>
        <FindButton detection={detection} again={again} />
        <Note>
          Runs on this computer, offline. Takes roughly {plural(minutes, "minute", "minutes")} for
          this recording.
        </Note>
      </div>
    );
  } else if (groups.length === 0) {
    body = (
      <div className="flex flex-col items-start gap-3">
        {phase === "failed" && (
          <Alert variant="error" title="Couldn't find the surahs" className="self-stretch">
            {detection.error}
          </Alert>
        )}
        <p className="text-sm text-text-secondary">
          No Quran recitation was recognised in this recording.
        </p>
        <Note>
          The model expects Hafs recitation with the voice clearly audible. Very quiet or distant
          audio may not match.
        </Note>
        <FindButton detection={detection} again variant="secondary" />
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {phase === "failed" && (
          <Alert variant="error" title="Couldn't find the surahs again">
            {detection.error}
          </Alert>
        )}
        <ul aria-label="Surahs" className="border-t border-border">
          {groups.map((group) => (
            <SurahRow
              key={group.surah}
              group={group}
              infos={infos}
              selected={selected === group.surah}
              hidden={group.surah === FATIHAH && !showFatihah}
              onSelect={() => selectSurah(group.surah)}
              onSeek={(passage) => selectSurah(group.surah, passage)}
              onKeepOnly={() => keepOnly(group)}
              onNewRecording={() =>
                setSplitFor({ group, ranges: rangesFor(group, editor.liveOps()) })
              }
            />
          ))}
        </ul>
        {anyUnsure && (
          <Note>
            <UnsureFlag /> means the words matched, but not strongly enough to be certain of the
            surah. Listen before cutting.
          </Note>
        )}
        <div className="flex items-center justify-between gap-3">
          <Note>
            Quran model · Hafs · matched{" "}
            {project.surahs ? formatRelativeTime(project.surahs.matched_at) : ""}
          </Note>
          <FindButton detection={detection} again variant="ghost" />
        </div>
      </div>
    );
  }

  const splitName = splitFor ? surahName(splitFor.group.surah, infos) : "";
  return (
    <div className="flex flex-col gap-4">
      <Header
        count={(phase === "done" || phase === "failed") && groups.length > 0 ? shown.length : null}
        showSwitches={project.surahs !== null && groups.length > 0}
      />
      {body}
      {splitFor && (
        <SplitModal
          project={project}
          ranges={splitFor.ranges}
          defaultName={`${project.name} · ${splitName}`}
          title={`New recording from ${splitName}`}
          onClose={() => setSplitFor(null)}
        />
      )}
    </div>
  );
}
