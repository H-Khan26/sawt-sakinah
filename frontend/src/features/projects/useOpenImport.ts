import type { EditorLocationState } from "@/pages/EditorPage";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Opens the editor on a recording whose import just started, handing it the job id to follow
 * (and the source link, for the editor's retry flow).
 */
export function useOpenImport() {
  const navigate = useNavigate();
  return useCallback(
    (projectId: string, jobId: string, url?: string) => {
      const state: EditorLocationState = { jobId, url };
      navigate(`/p/${projectId}`, { state });
    },
    [navigate],
  );
}
