import { ServerThrower } from "./server-thrower";

export const dynamic = "force-dynamic";

// The client component throws outside any boundary, so the HTML shell fails
// and the server sends the default error document instead.
export default function ShellError() {
  return <ServerThrower />;
}
