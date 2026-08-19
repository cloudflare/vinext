import { ActionButton } from "../action-button";
import { groupedActions } from "../barrels/namespace";

export default function Page() {
  return <ActionButton id="namespace-barrel" action={groupedActions.namespaceBarrelAction} />;
}
