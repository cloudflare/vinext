import { Suspense } from "react";
import { AccountMenu } from "./account-menu";

export default function LateCookieLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div>
      <Suspense fallback={null}>
        <AccountMenu />
      </Suspense>
      {children}
      {modal}
    </div>
  );
}
