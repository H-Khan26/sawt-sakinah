/**
 * App settings: the speech-model catalog (download, remove, choose the active model), the
 * YouTube cookies source, the update check, a shortcut to the logs folder, and what the app
 * talks to over the network.
 * Everything here is backend state (`/models`, `/app/*`); the parent mounts this only while
 * open. A download keeps running server-side after close and resumes its progress on reopen.
 */
import {
  useAppInfo,
  useDeleteModel,
  useModels,
  useOpenLogs,
  usePatchPreferences,
  usePreferences,
  useSelectModel,
  useUpdateStatus,
} from "@/api/hooks";
import { Badge, Button, Input, Modal, WaveformLoader } from "@/components/ui";
import { ModelDownloadProgress } from "@/features/models/ModelDownload";
import { useModelDownload } from "@/features/models/useModelDownload";
import { CheckForUpdatesLink } from "@/features/updates/UpdateBanner";
import { formatMegabytes } from "@/lib/format";
import type { CookieBrowser, SpeechModel } from "@/types/api";
import { FolderOpen } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

function ModelRow({
  model,
  onSelect,
  selecting,
}: {
  model: SpeechModel;
  onSelect: (id: string) => void;
  selecting: boolean;
}) {
  const download = useModelDownload(model);
  const remove = useDeleteModel();
  const inputId = `speech-model-${model.id}`;

  return (
    <li className="flex flex-col gap-2 rounded border border-border p-3">
      <div className="flex items-start gap-3">
        <input
          id={inputId}
          type="radio"
          name="speech-model"
          className="accent-accent mt-1 h-4 w-4 shrink-0 cursor-pointer"
          checked={model.selected}
          disabled={selecting}
          onChange={() => onSelect(model.id)}
        />
        <label htmlFor={inputId} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text">{model.label}</span>
            <span className="text-sm tabular-nums text-text-tertiary">
              {formatMegabytes(model.size_mb)}
            </span>
            {model.installed ? (
              <Badge variant="success">Downloaded</Badge>
            ) : (
              <Badge>Not downloaded</Badge>
            )}
          </span>
          <span className="text-sm text-text-secondary">{model.description}</span>
        </label>
        <div className="shrink-0">
          {!model.installed && !download.active && (
            <Button size="sm" variant="secondary" onClick={download.start}>
              Download
            </Button>
          )}
          {model.installed && !model.selected && (
            <Button
              size="sm"
              variant="ghost"
              loading={remove.isPending}
              onClick={() => remove.mutate(model.id)}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      {download.active && (
        <ModelDownloadProgress download={download} label={`Downloading ${model.label}`} />
      )}
      {download.failed && <p className="text-sm text-danger">Download failed: {download.error}</p>}
      {remove.isError && (
        <p className="text-sm text-danger">Couldn't remove the model: {remove.error.message}</p>
      )}
    </li>
  );
}

function SpeechModelSection() {
  const models = useModels();
  const select = useSelectModel();

  return (
    <Section title="Speech model">
      <p className="text-sm text-text-secondary">
        Phrase detection uses this model to find the takbir and other prayer phrases. It runs on
        your computer's CPU and takes a few minutes per recording.
      </p>
      {models.isPending ? (
        <WaveformLoader size={20} label="Loading models" className="text-accent" />
      ) : models.isError ? (
        <p className="text-sm text-danger">Couldn't load the model list: {models.error.message}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {models.data.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              onSelect={(id) => select.mutate(id)}
              selecting={select.isPending}
            />
          ))}
        </ul>
      )}
      {select.isError && (
        <p className="text-sm text-danger">Couldn't change the model: {select.error.message}</p>
      )}
    </Section>
  );
}

type CookieMode = "off" | "browser" | "file";

const COOKIE_MODES: { value: CookieMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "browser", label: "From a browser" },
  { value: "file", label: "From a cookies.txt file" },
];

const BROWSER_LABELS: Record<CookieBrowser, string> = {
  chrome: "Chrome",
  edge: "Microsoft Edge",
  firefox: "Firefox",
  brave: "Brave",
  chromium: "Chromium",
  vivaldi: "Vivaldi",
  opera: "Opera",
  safari: "Safari",
};

const SELECT_CLASS =
  "h-10 rounded border border-border bg-background px-3 text-base text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50";

/**
 * Where YouTube imports read sign-in cookies from: nowhere, a browser profile, or a
 * cookies.txt file. Radio and browser choices save at once; the file choice stays local until
 * a path is saved, so the stored setting only changes to a file the backend accepted.
 */
function CookiesSection() {
  const prefs = usePreferences();
  const info = useAppInfo();
  const patch = usePatchPreferences();
  const saveFile = usePatchPreferences();

  const savedBrowser = prefs.data?.cookies_browser ?? null;
  const savedFile = prefs.data?.cookies_file ?? null;
  const savedMode: CookieMode = savedFile ? "file" : savedBrowser ? "browser" : "off";
  const [fileChosen, setFileChosen] = useState(false);
  const mode: CookieMode = fileChosen ? "file" : savedMode;

  // The typed path; until the user edits it the field shows the saved one.
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const path = draftPath ?? savedFile ?? "";

  const offered = info.data?.cookie_browsers ?? [];
  const browsers =
    savedBrowser && !offered.includes(savedBrowser) ? [...offered, savedBrowser] : offered;

  const chooseMode = (next: CookieMode) => {
    setFileChosen(next === "file");
    if (next !== "file") saveFile.reset();
    if (next === "file" || next === savedMode) return;
    if (next === "off") {
      patch.mutate({ cookies_browser: null, cookies_file: null });
    } else {
      const browser = savedBrowser ?? offered[0];
      if (browser) patch.mutate({ cookies_browser: browser, cookies_file: null });
    }
  };

  const onSaveFile = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = path.trim();
    if (!trimmed) return;
    saveFile.mutate(
      { cookies_browser: null, cookies_file: trimmed },
      { onSuccess: () => setFileChosen(false) },
    );
  };

  return (
    <Section title="YouTube cookies">
      <p className="text-sm text-text-secondary">
        YouTube sometimes asks to confirm you're not a bot. Signing in through your browser's
        cookies usually gets past that. Cookies are only used for YouTube imports and stay on this
        computer: the app reads them on each import and never copies or uploads them anywhere else.
      </p>
      <fieldset className="flex min-w-0 flex-col gap-2" disabled={!prefs.data}>
        <legend className="sr-only">Use cookies</legend>
        {COOKIE_MODES.map((m) => {
          const inputId = `cookies-mode-${m.value}`;
          return (
            <label
              key={m.value}
              htmlFor={inputId}
              className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary"
            >
              <input
                id={inputId}
                type="radio"
                name="cookies-mode"
                className="accent-accent h-4 w-4 cursor-pointer"
                checked={mode === m.value}
                disabled={m.value === "browser" && browsers.length === 0}
                onChange={() => chooseMode(m.value)}
              />
              {m.label}
            </label>
          );
        })}
      </fieldset>

      {mode === "browser" && (
        <div className="flex flex-col gap-1.5 pl-6">
          <label
            htmlFor="cookies-browser"
            className="flex flex-col gap-1.5 text-sm font-medium text-text-secondary"
          >
            Browser
            <select
              id="cookies-browser"
              className={SELECT_CLASS}
              value={savedBrowser ?? ""}
              disabled={!prefs.data}
              aria-describedby="cookies-browser-hint"
              onChange={(e) =>
                patch.mutate({
                  cookies_browser: e.target.value as CookieBrowser,
                  cookies_file: null,
                })
              }
            >
              {browsers.map((b) => (
                <option key={b} value={b}>
                  {BROWSER_LABELS[b] ?? b}
                </option>
              ))}
            </select>
          </label>
          <p id="cookies-browser-hint" className="text-sm text-text-tertiary">
            Sign in to YouTube in that browser first. On Windows, Chrome and Edge may need to be
            closed while importing; Firefox works most reliably.
          </p>
        </div>
      )}

      {mode === "file" && (
        <form className="flex items-start gap-2 pl-6" onSubmit={onSaveFile}>
          <div className="min-w-0 flex-1">
            <Input
              id="cookies-file"
              label="cookies.txt path"
              placeholder="C:\Users\you\cookies.txt"
              value={path}
              spellCheck={false}
              autoComplete="off"
              invalid={saveFile.isError}
              hint={
                saveFile.isError
                  ? saveFile.error.message
                  : savedMode === "file"
                    ? "Imports read this file. Save again after changing the path."
                    : "The full path to a Netscape-format cookies.txt file. Nothing changes until you save."
              }
              onChange={(e) => {
                setDraftPath(e.target.value);
                if (saveFile.isError) saveFile.reset();
              }}
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            className="mt-[26px]"
            loading={saveFile.isPending}
            disabled={!path.trim() || path.trim() === savedFile}
          >
            Save
          </Button>
        </form>
      )}

      {patch.isError && (
        <p className="text-sm text-danger">Couldn't save that change: {patch.error.message}</p>
      )}
    </Section>
  );
}

function UpdatesSection() {
  const prefs = usePreferences();
  const patch = usePatchPreferences();
  const info = useAppInfo();
  const update = useUpdateStatus();

  return (
    <Section title="Updates">
      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          className="accent-accent h-4 w-4 cursor-pointer"
          checked={prefs.data?.update_check ?? false}
          disabled={!prefs.data}
          onChange={(e) => patch.mutate({ update_check: e.target.checked })}
        />
        Check for updates on launch
      </label>
      {prefs.isError && <p className="text-sm text-danger">Couldn't load your preferences.</p>}
      {patch.isError && (
        <p className="text-sm text-danger">Couldn't save that change: {patch.error.message}</p>
      )}
      <p className="text-sm text-text-secondary">
        {info.data ? `Sawt Sakinah ${info.data.version}` : "Sawt Sakinah"}
        {update.data?.update_available && update.data.latest && (
          <>
            {" "}
            · Version {update.data.latest} is available. <CheckForUpdatesLink />
          </>
        )}
      </p>
    </Section>
  );
}

function TroubleshootingSection() {
  const openLogs = useOpenLogs();
  return (
    <Section title="Troubleshooting">
      <div>
        <Button
          size="sm"
          variant="secondary"
          loading={openLogs.isPending}
          onClick={() => openLogs.mutate()}
        >
          <FolderOpen size={16} />
          Open logs folder
        </Button>
      </div>
      {openLogs.isError && (
        <p className="text-sm text-danger">
          Couldn't open the logs folder: {openLogs.error.message}
        </p>
      )}
    </Section>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} ariaLabel="Settings" className="max-w-xl">
      <div className="border-b border-border px-5 py-3 font-serif text-lg">Settings</div>

      <div className="flex flex-col gap-6 px-5 py-4">
        <SpeechModelSection />
        <CookiesSection />
        <UpdatesSection />
        <TroubleshootingSection />
        <p className="border-t border-border pt-4 text-xs text-text-tertiary">
          Sawt Sakinah only goes online to import from YouTube, download speech models from Hugging
          Face and check GitHub for updates. It sends no telemetry.
        </p>
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
