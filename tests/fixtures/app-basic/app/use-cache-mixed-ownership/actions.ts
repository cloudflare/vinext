export const ownershipLabel = "cache";

export async function builtinAction() {
  "use server";
  return "builtin";
}

export async function flexibleAction() {
  "use cache";
  return `cached:${Math.random()}`;
}
