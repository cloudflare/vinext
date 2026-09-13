import { ActionButton } from "../action-button";
import { publicAction } from "../actions/admin";
export default function Page() {
  return <ActionButton id="public" action={publicAction} />;
}
