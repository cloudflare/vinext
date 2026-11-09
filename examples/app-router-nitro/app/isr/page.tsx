import type { Metadata } from "next";
import { s } from "../_styles.js";

export const metadata: Metadata = {
  title: "ISR",
  description: "A page cached by vinext's ISR cache and revalidated hourly",
};

export const revalidate = 3600;

export default function IsrPage() {
  return (
    <main style={s.page}>
      <h1 style={s.title}>ISR</h1>
      <p data-testid="isr-timestamp" style={s.badge}>
        Rendered at: {new Date().toISOString()}
      </p>
    </main>
  );
}
