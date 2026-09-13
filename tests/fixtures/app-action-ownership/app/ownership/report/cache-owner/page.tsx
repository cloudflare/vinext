import { ActionButton } from "../../action-button";
import { cachedProtectedAction } from "./actions";

export default function Page() {
  return <ActionButton id="cached-protected" action={cachedProtectedAction} />;
}
