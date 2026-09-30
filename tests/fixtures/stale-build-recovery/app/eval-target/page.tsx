import { EvalWidget } from "./eval-widget";
import { VERSION } from "../version";

export default function EvalTargetPage() {
  return (
    <main>
      <h1 id="target">Evaluation failure target {VERSION}</h1>
      <EvalWidget />
    </main>
  );
}
