import { ActionButton } from "../../../action-button";
import { adminSharedAction } from "../../shared-actions";

export default function Page() {
  return <ActionButton id="admin-shared" action={adminSharedAction} />;
}
