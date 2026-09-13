import { builtinAction, flexibleAction, ownershipLabel } from "./actions";
import { MixedOwnershipClient } from "./client";

export default function UseCacheMixedOwnershipPage() {
  return (
    <main data-testid="use-cache-mixed-ownership-page">
      <output data-testid="mixed-ownership-label">{ownershipLabel}</output>
      <MixedOwnershipClient builtinAction={builtinAction} flexibleAction={flexibleAction} />
    </main>
  );
}
