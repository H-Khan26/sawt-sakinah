import { useCreateProject } from "@/api/hooks";
import { Alert, Button, Card, Input } from "@/components/ui";
import { isLikelyYouTubeUrl } from "@/lib/youtube";
import { ArrowLeft } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { EditorLocationState } from "./EditorPage";

/**
 * New-project flow: paste a YouTube link -> POST /projects -> navigate to the editor carrying
 * the extraction job id (and the url, so the editor can offer a retry). The URL check is
 * intentionally loose; the backend is the real validator. Reached from the library at `/`.
 */
export function NewProjectPage() {
  const navigate = useNavigate();
  const create = useCreateProject();
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);

  const invalid = touched && url.trim().length > 0 && !isLikelyYouTubeUrl(url);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!isLikelyYouTubeUrl(url)) return;
    create.mutate(
      { url: url.trim() },
      {
        onSuccess: ({ project_id, job_id }) => {
          const state: EditorLocationState = { jobId: job_id, url: url.trim() };
          navigate(`/p/${project_id}`, { state });
        },
      },
    );
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <div className="flex flex-col gap-5">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="inline-flex items-center gap-1.5 self-start text-sm text-text-secondary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus rounded"
          >
            <ArrowLeft size={16} />
            Back to library
          </button>

          <div className="text-center">
            <h1 className="font-serif text-3xl text-accent">New project</h1>
            <p className="mt-1 text-text-secondary">
              Paste a YouTube link to clean up a Quran recitation recording.
            </p>
          </div>

          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <Input
              label="YouTube link"
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => setTouched(true)}
              invalid={invalid}
              hint={invalid ? "That doesn't look like a YouTube link." : undefined}
              autoFocus
              inputMode="url"
            />
            <Button type="submit" loading={create.isPending} disabled={url.trim().length === 0}>
              Start
            </Button>
          </form>

          {create.isError && (
            <Alert variant="error" title="Couldn't start extraction">
              {create.error.message}
            </Alert>
          )}
        </div>
      </Card>
    </div>
  );
}
