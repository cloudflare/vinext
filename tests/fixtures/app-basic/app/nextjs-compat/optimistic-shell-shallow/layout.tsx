import { Suspense } from "react";
import DebugMode from "../use-link-status/debug-mode";
import NavBar from "./nav-bar";

export default function OptimisticShellShallowLayout({ children }: { children: React.ReactNode }) {
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
