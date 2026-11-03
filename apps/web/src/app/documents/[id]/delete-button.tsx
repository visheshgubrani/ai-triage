"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

/** Deletes the document and everything derived from it (admins). Eval-set copies are kept. */
export function DeleteDocumentButton({ id }: { id: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    const sure = window.confirm(
      "Delete this document permanently? Its files, extractions, review history and actions go with it. This can't be undone.",
    );
    if (!sure) return;
    const res = await browserApi.documents[":id"].$delete({ param: { id } });
    if (!res.ok) return setError((await readError(res)).error);
    router.push("/documents");
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button onClick={() => void remove()}>Delete</Button>
      {error && (
        <span role="alert" className="text-sm text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}
