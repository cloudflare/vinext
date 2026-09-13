import type { Metadata } from "next";
import BrowserStateDemo from "./browser-state-demo";

export const metadata: Metadata = { title: "Browser state" };

export default function BrowserStatePage() {
  return (
    <section className="detail-page">
      <p className="kicker">Client Component</p>
      <h1>Interactivity survives the export.</h1>
      <p className="detail-intro">The initial view is prerendered. React then hydrates it and safely uses browser-only APIs from an effect.</p>
      <BrowserStateDemo />
    </section>
  );
}
