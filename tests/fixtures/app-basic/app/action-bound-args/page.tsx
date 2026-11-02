import { BoundArgsActions } from "./bound-args-actions";

// Two inline Server Actions on one route with same-shaped closures. Like
// Next.js, each closure's encrypted captures only decrypt for the action they
// were bound to: `preview`'s captures (its `label` comes from the URL) must not
// stand in for `readSecret`'s `role`.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ label?: string }>;
}) {
  const { label = "guest" } = await searchParams;
  const role = "viewer";

  async function preview() {
    "use server";
    return `PREVIEW:${label}`;
  }

  async function readSecret() {
    "use server";
    return role === "admin" ? "BOUND_ARGS_SECRET" : `DENIED:${role}`;
  }

  return <BoundArgsActions preview={preview} readSecret={readSecret} />;
}
