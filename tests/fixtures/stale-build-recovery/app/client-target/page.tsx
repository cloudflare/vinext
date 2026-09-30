import { ClientWidget } from "./client-widget";
import { VERSION } from "../version";

export default function ClientTargetPage() {
  return (
    <main>
      <h1 id="target">Client target {VERSION}</h1>
      <ClientWidget />
    </main>
  );
}
