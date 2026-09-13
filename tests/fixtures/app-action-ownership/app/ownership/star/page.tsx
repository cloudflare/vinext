import { ActionButton } from "../action-button";
import { starAction as action } from "../barrels/star";
export default function Page() {
  return <ActionButton id="star" action={action} />;
}
