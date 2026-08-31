import { ActionButton } from "../action-button";
import { originalAliasAction as action } from "../actions/alias";
export default function Page() {
  return <ActionButton id="alias" action={action} />;
}
