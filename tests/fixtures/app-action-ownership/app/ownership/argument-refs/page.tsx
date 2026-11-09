import { ActionButton } from "../action-button";
import { describeArgument, describeBoundArgument } from "./actions";

export default function Page() {
  async function inlineArgumentAction() {
    "use server";
    return "INLINE_ARGUMENT_OK";
  }
  return (
    <main>
      <ActionButton id="argument-refs" action={describeArgument} />
      <ActionButton id="argument-refs-inline" action={inlineArgumentAction} />
      <ActionButton id="argument-refs-bound" action={describeBoundArgument} />
    </main>
  );
}
