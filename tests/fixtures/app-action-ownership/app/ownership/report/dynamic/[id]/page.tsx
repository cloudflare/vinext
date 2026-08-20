import { ActionButton } from "../../../action-button";

export default function Page() {
  const dynamicProtectedAction = async () => {
    "use server";
    return "DYNAMIC_PROTECTED_ACTION_EXECUTED";
  };

  return <ActionButton id="dynamic-protected" action={dynamicProtectedAction} />;
}
