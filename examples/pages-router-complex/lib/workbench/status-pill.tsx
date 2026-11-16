import { useState } from "react";

const TONES = ["idle", "busy", "blocked"] as const;

// Records each evaluation, so specs can check that this shared module runs
// once, and only on pages that import it, however the build chunks it.
if (typeof window !== "undefined") {
  const target = window as Window & { __WORKBENCH_EVALUATIONS__?: string[] };
  (target.__WORKBENCH_EVALUATIONS__ ??= []).push("status-pill");
}

/** Clickable status indicator; every desk and the lazy breakdown use it. */
export const StatusPill = ({ label }: { label: string }) => {
  const [tone, setTone] = useState(0);
  return (
    <button
      type="button"
      data-testid={`status-pill-${label}`}
      data-tone={TONES[tone]}
      onClick={() => setTone((current) => (current + 1) % TONES.length)}
    >
      {label}: {TONES[tone]}
    </button>
  );
};
