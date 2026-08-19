import { ActionButton } from "../action-button";
import { mixedStaticAction } from "../actions/mixed";

export default async function Page() {
  const { mixedDynamicAction } = await import("../actions/mixed");
  return (
    <>
      <ActionButton id="mixed-static" action={mixedStaticAction} />
      <ActionButton id="mixed-dynamic" action={mixedDynamicAction} />
    </>
  );
}
