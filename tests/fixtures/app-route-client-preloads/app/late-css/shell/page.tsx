import { Unused } from "./unused";

export const dynamic = "force-dynamic";

export default function LateShellPage() {
  const show = Date.now() < 0;
  return <p data-testid="late-shell">{show ? <Unused /> : "hidden"}</p>;
}
