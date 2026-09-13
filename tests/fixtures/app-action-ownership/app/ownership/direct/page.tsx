import { ActionButton } from "../action-button";
import { directAction } from "../actions/direct";
export default function Page() {
  return <ActionButton id="direct" action={directAction} />;
}
