import { ActionButton } from "../action-button";
export default function Page() {
  const routeInlineAction = async () => {
    "use server";
    return "ROUTE_INLINE_OK";
  };
  return <ActionButton id="route-inline" action={routeInlineAction} />;
}
