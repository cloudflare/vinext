import { ActionButton } from "../action-button";
export default async function Page() {
  const { dynamicAction } = await import("../actions/dynamic");
  return <ActionButton id="dynamic" action={dynamicAction} />;
}
