import { ActionButton } from "../../action-button";

export default function Page() {
  const loopAction = async () => {
    "use server";
    return "LOOP_ACTION_EXECUTED";
  };

  return <ActionButton id="loop" action={loopAction} />;
}
