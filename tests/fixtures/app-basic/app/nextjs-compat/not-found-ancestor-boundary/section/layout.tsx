/**
 * Test fixture: child layout below the not-found boundary's segment. Next.js
 * does not draw it when the page below calls notFound(), and keeps its client
 * state across sibling pages whose nearest not-found file differs.
 */
import { SectionCounter } from "./counter";

export default function SectionLayout({ children }: { children: React.ReactNode }) {
  return (
    <div id="not-found-ancestor-boundary-section">
      <h1>Section layout</h1>
      <SectionCounter />
      {children}
    </div>
  );
}
