import { ActionErrorTrigger } from "../trigger";

// instrumentation.spec.ts asserts on the errors recorded for this path alone,
// while action-error-sanitization specs throw on the parent page in parallel.
export default function InstrumentationActionErrorPage() {
  return (
    <main>
      <ActionErrorTrigger />
    </main>
  );
}
