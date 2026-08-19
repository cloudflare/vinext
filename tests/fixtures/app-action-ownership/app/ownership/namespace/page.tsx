import { ActionButton } from "../action-button";
import * as actions from "../actions/namespace";
export default function Page() {
  return <ActionButton id="namespace" action={actions.namespaceAction} />;
}
