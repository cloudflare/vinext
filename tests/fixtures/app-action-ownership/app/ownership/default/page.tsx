import { ActionButton } from "../action-button";
import action from "../actions/default";
export default function Page() {
  return <ActionButton id="default" action={action} />;
}
