// An exact key keeps the `?raw` query on its fixed fallback too.
import source from "@fixed-exact?raw";

export default function ResolveFixedExactRaw() {
  return <pre>{source}</pre>;
}
