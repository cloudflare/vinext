"use server";

let saved = 0;

export async function save(): Promise<number> {
  saved += 1;
  return saved;
}
