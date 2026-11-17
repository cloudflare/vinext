import { ExternalUsed } from "fake-external-barrel";
import { ClientExternal } from "./client-external";

export default function Page() {
  return (
    <main>
      <ExternalUsed id="server-external" />
      <ClientExternal />
    </main>
  );
}
