import { EffectProbe } from "../effect-probe";
import { StatusLink } from "../../link-status/status-link";

export default function ShotsPage() {
  return (
    <>
      <h2>Shots</h2>
      <EffectProbe name="shots" />
      <StatusLink href="/bfcache-effects/shots/1" id="shots-open-shot" label="Open shot 1" />
    </>
  );
}
