import { ActionButton } from "../../action-button";
import { publicSharedAction } from "../shared-actions";

export default function Page() {
  return <ActionButton id="public-shared" action={publicSharedAction} />;
}
