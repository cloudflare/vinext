import { Suspense } from "react";
import DebugMode from "./debug-mode";
import NavBar from "./nav-bar";

export default function UseLinkStatusLayout({ children }: { children: React.ReactNode }) {
  return (
    <main>
      <NavBar />
      {children}
      <Suspense>
        <DebugMode />
      </Suspense>
    </main>
  );
}
