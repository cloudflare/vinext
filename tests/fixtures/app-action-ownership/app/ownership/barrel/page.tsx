import { ActionButton } from "../action-button";
import { renamedBarrelAction as action } from "../barrels/named";
export default function Page() {
  return <ActionButton id="barrel" action={action} />;
}
