import { useAppInfo, useDeleteProject } from "@/api/hooks";
import { SimpleModal, useToast } from "@/components/ui";

/**
 * Confirm and delete a recording. Deletion is irreversible — it removes the extracted audio
 * and any exports kept in the app (files saved to the user's folders stay) — so it is always
 * gated behind this confirm. A failure toasts the
 * backend's reason and keeps the dialog open for a retry.
 */
export function DeleteDialog({
  projectId,
  name,
  onClose,
}: {
  projectId: string;
  name: string;
  onClose: () => void;
}) {
  const del = useDeleteProject();
  const toFolder = useAppInfo().data?.export_to_folder ?? false;
  const { toast } = useToast();

  const onConfirm = () => {
    del.mutate(projectId, {
      onSuccess: () => {
        toast("Recording deleted.", "success");
        onClose();
      },
      // The dialog stays open so the user can retry (e.g. after a 409 while files are in use).
      onError: (err) => toast(`Couldn't delete the recording: ${err.message}`, "error"),
    });
  };

  return (
    <SimpleModal
      open
      onClose={onClose}
      title="Delete recording"
      confirm={{ label: "Delete", onClick: onConfirm, variant: "danger", loading: del.isPending }}
    >
      Delete <span className="font-medium text-text">{name}</span>? This permanently removes its
      audio
      {toFolder ? ". Files you exported stay in their folders" : " and any exports"}. This can't be
      undone.
    </SimpleModal>
  );
}
