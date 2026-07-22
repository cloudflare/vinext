import Reporter from "./reporter";

export default function ReportWebVitalsPage() {
  return (
    <main>
      <h1>Report Web Vitals</h1>
      <button id="web-vitals-interaction" type="button">
        Trigger interaction
      </button>
      <Reporter />
    </main>
  );
}
