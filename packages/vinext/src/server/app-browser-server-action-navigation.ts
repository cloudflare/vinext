import type { ServerActionResultDecision } from "./navigation-planner.js";

// Dispatches the executor effects implied by a ServerActionResultDecision.
// Returns true if a hard-navigation was triggered (the caller should return early);
// false if the decision is "proceed" and normal action processing should continue.
// Both callbacks are injected so this function is testable without browser globals.
export function applyServerActionResultDecision(
  decision: ServerActionResultDecision,
  clearCaches: () => void,
  performHardNavigation: (url: string, historyMode?: "assign" | "replace") => void,
): boolean {
  if (decision.kind !== "hardNavigate") return false;
  if (decision.clearClientNavigationCaches) clearCaches();
  performHardNavigation(decision.url, decision.historyMode);
  return true;
}
