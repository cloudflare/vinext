// The `?raw` query stays on the fixed fallback, so this is lib/fixed.ts' source.
import source from "@fixed/b-only?raw";

export default function ResolveFixedRaw() {
  return <pre>{source}</pre>;
}
