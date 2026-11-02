"use client";

import { useActionState } from "react";
import { digestUpload } from "./actions";

export function UploadForm() {
  const [result, action, pending] = useActionState(digestUpload, "");
  return (
    <form action={action}>
      <input type="file" name="file" data-testid="upload-file" />
      <button type="submit" disabled={pending}>
        upload
      </button>
      <p data-testid="upload-result">{result}</p>
    </form>
  );
}
