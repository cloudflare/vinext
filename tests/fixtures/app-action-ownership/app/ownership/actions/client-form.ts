"use server";

export async function submitClientForm(_previousState: string, formData: FormData) {
  return `CLIENT_FORM_OK:${formData.get("message")}`;
}
