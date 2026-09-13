"use server";

export async function submit(_previousState: string, formData: FormData) {
  return `SAME_NAME_ACTION_OK:${formData.get("message")}`;
}
