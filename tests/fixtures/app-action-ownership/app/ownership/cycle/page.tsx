import { ActionButton } from "../action-button";
import { cycleAction as action } from "../barrels/cycle-b";
export default function Page() {
  return <ActionButton id="cycle" action={action} />;
}
