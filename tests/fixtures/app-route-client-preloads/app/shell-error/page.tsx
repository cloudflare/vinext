import { ServerThrower } from "./server-thrower";
import { ShellErrorNote } from "./shell-error-note";

export const dynamic = "force-dynamic";

// The client component throws outside any boundary, so the HTML shell fails
// and the server sends the default error document instead. The note renders
// only with `?note`, so the failed render never reads it.
export default async function ShellError({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { note } = await searchParams;
  return (
    <>
      <ServerThrower />
      {note !== undefined && <ShellErrorNote />}
    </>
  );
}
