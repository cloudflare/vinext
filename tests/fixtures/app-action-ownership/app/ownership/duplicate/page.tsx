import { ActionButton } from "../action-button";
import { duplicateFirstAction } from "../actions/duplicate";
import { duplicateSecondAction } from "../actions/duplicate";
export default function Page() {
  return (
    <>
      <ActionButton id="duplicate-first" action={duplicateFirstAction} />
      <ActionButton id="duplicate-second" action={duplicateSecondAction} />
    </>
  );
}
