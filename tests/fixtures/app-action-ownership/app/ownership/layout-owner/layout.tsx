import type { ReactNode } from "react";
import { ActionButton } from "../action-button";

export default function Layout({ children }: { children: ReactNode }) {
  const layoutAction = async () => {
    "use server";
    return "LAYOUT_OK";
  };
  return (
    <>
      <ActionButton id="layout-owner" action={layoutAction} />
      {children}
    </>
  );
}
