/**
 * App settings: the speech-model catalog (download, remove, choose the active model), the
 * update check, a shortcut to the logs folder, and what the app talks to over the network.
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
import { Badge, Button, Modal, WaveformLoader } from "@/components/ui";
import { ModelDownloadProgress } from "@/features/models/ModelDownload";
import { useModelDownload } from "@/features/models/useModelDownload";
import { CheckForUpdatesLink } from "@/features/updates/UpdateBanner";
import { formatMegabytes } from "@/lib/format";
import type { SpeechModel } from "@/types/api";
import { FolderOpen } from "lucide-react";
import type { ReactNode } from "react";

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
