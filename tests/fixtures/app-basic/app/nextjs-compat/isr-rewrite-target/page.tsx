import { PathnameClient } from "./pathname-client";

export const revalidate = 1;

export default function IsrRewriteTargetPage() {
  return (
    <div>
      <h1 id="isr-rewrite-page">ISR Rewrite Target</h1>
      <PathnameClient />
    </div>
  );
}
