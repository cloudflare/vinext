import type { CSSProperties } from "react";

export type LandingStyle = CSSProperties & Partial<Record<`--${string}`, string | number>>;

export const landingRootStyle = {
  "--t": ".48s var(--ease-out)",
  position: "relative",
  background: "var(--bg)",
  color: "var(--ink)",
  fontFamily: "'Geist',system-ui,-apple-system,sans-serif",
} satisfies LandingStyle;

export const provenanceStyle = {
  opacity: "0",
  transform: "translateY(24px)",
  transition: "opacity var(--t),transform var(--t)",
  transitionDelay: ".1s",
  margin: "16px 0 0",
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: "11px",
  lineHeight: "1.5",
  color: "var(--mute)",
} satisfies LandingStyle;
