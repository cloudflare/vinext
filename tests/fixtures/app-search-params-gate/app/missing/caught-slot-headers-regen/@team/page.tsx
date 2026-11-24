import { notFound } from "next/navigation";

export default function TeamPage() {
  if (Reflect.get(globalThis, "__SEARCH_PARAMS_GATE_TEAM_MISSING__") === true) notFound();
  return <span data-testid="team">team</span>;
}
