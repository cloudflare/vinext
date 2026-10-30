import { Suspense, type ReactNode } from "react";

async function BuildStamp() {
  "use cache";
  return <p id="resume-stamp">{`stamp:${process.env.NEXT_PHASE ?? "runtime"}`}</p>;
}

export default function ResumeLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <BuildStamp />
      <Suspense fallback={<p>Loading resumed route</p>}>{children}</Suspense>
    </>
  );
}
