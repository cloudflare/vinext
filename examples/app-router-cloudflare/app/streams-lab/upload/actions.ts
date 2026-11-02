"use server";

import { sha256Hex } from "../../api/streams-lab/digest";

/** Reads an uploaded file through file.stream() and returns its digest. */
export async function digestUpload(_previous: string, form: FormData): Promise<string> {
  const file = form.get("file");
  if (!(file instanceof File)) return "no file";
  return `${file.size} ${await sha256Hex(file.stream())}`;
}
