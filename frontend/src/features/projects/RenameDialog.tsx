import { useRenameProject } from "@/api/hooks";
import { Button, Input, Modal, useToast } from "@/components/ui";
import type { FormEvent } from "react";
import { useState } from "react";

const MAX_NAME = 200;

/**
 * Rename a recording. Trims and validates locally (non-empty, <=200 chars) before firing, so
 * we avoid the backend's 400 round-trip. The mutation is optimistic with rollback, so we can
 * close immediately; a failure surfaces as a toast and the name reverts.
 */
export function RenameDialog({
  projectId,
  currentName,
  onClose,
}: {
  projectId: string;
  currentName: string;
  onClose: () => void;
}) {
  const rename = useRenameProject();
  const { toast } = useToast();
  const [name, setName] = useState(currentName);

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_NAME;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || trimmed === currentName) {
      onClose();
      return;
    }
    rename.mutate(
      { id: projectId, name: trimmed },
      { onError: () => toast("Couldn't rename the recording.", "error") },
    );
    onClose();
  };

  return (
    <Modal open onClose={onClose} ariaLabel="Rename recording">
      <form onSubmit={onSubmit}>
        <div className="border-b border-border px-5 py-3 font-serif text-lg">Rename recording</div>
        <div className="px-5 py-4">
          <Input
            label="Recording name"
            value={name}
            maxLength={MAX_NAME}
            onChange={(e) => setName(e.target.value)}
            invalid={name.length > 0 && !valid}
            hint={name.length > 0 && !valid ? "Enter a name (up to 200 characters)." : undefined}
            autoFocus
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
