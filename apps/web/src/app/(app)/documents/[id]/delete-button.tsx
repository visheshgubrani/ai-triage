"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

/** Deletes the document and everything derived from it (admins). Eval-set copies are kept. */
export function DeleteDocumentButton({ id }: { id: string }) {
  const confirm = useConfirm();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    const sure = await confirm({
      title: "Delete this document permanently?",
      body: "Its files, extractions, review history and actions go with it. This can't be undone.",
      confirm: "Delete document",
      destructive: true,
    });
    if (!sure) return;
    const res = await browserApi.documents[":id"].$delete({ param: { id } });
    if (!res.ok) return setError((await readError(res)).error);
    router.push("/documents");
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="danger" onClick={() => void remove()}>
        <Trash2 aria-hidden="true" />
        Delete
      </Button>
      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
