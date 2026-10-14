import { cookies } from "next/headers";
import { ActionButton } from "../../action-button";

// Two inline actions on one route whose closures have the same shape. The
// preview capture comes from the URL; the protected capture is fixed by the
// server. Each closure's ciphertext must only decrypt for its own action.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string }>;
}) {
  const previewOwner = (await searchParams).owner ?? "guest";
  const previewAction = async () => {
    "use server";
    return `PREVIEW:${previewOwner}`;
  };

  const protectedOwner = "victim-dave";
  const readProtectedAction = async () => {
    "use server";
    const viewer = (await cookies()).get("viewer")?.value ?? "anonymous";
    if (viewer !== protectedOwner) return `DENIED:${viewer}`;
    return "BOUND_ARGS_SECRET_MARKER_77";
  };

  return (
    <>
      <ActionButton id="bound-args-preview" action={previewAction} />
      <ActionButton id="bound-args-protected" action={readProtectedAction} />
    </>
  );
}
