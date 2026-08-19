import { ActionButton } from "../../action-button";
import { protectedAction } from "./actions";

export default function Page() {
  return <ActionButton id="protected" action={protectedAction} />;
}
