import { ExternalUsed } from "fake-external-barrel";
import { ToastUsed, UNSTABLE_ToastQueue, useToastQueue } from "react-aria-components/Toast";
import { ClientExternal } from "./client-external";

export default function Page() {
  return (
    <main>
      <ExternalUsed id="server-external" />
      <ClientExternal />
      <ToastUsed id="server-subpath" />
      <span data-testid="toast-queue">{typeof UNSTABLE_ToastQueue}</span>
      <span data-testid="toast-hook">{typeof useToastQueue}</span>
    </main>
  );
}
