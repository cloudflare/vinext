"use server";

export async function toSlug(label: string) {
  return label.toLowerCase().replaceAll(" ", "-");
}
