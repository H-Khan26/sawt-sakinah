import { useCreateProject } from "@/api/hooks";
import { Alert, Button, Card, Input } from "@/components/ui";
import { isLikelyYouTubeUrl } from "@/lib/youtube";
import type { FormEvent } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { EditorLocationState } from "./EditorPage";

/**
 * Landing: paste a YouTube link -> POST /projects -> navigate to the editor carrying the
 * extraction job id (and the url, so the editor can offer a retry). The URL check is
 * intentionally loose; the backend is the real validator.
 */
export function LandingPage() {
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
          <div className="text-center">
            <h1 className="font-serif text-3xl text-accent">Sawt Sakinah</h1>
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
