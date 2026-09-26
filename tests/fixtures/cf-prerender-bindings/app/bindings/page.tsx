import { env } from "cloudflare:workers";

export default function BindingsPage() {
  return <div id="bindings-kind">{String(typeof env)}</div>;
}
