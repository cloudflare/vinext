/**
 * next/web-vitals shim
 *
 * Provides useReportWebVitals() — a no-op hook for compatibility.
 * In real Next.js, this sends Core Web Vitals to an analytics endpoint.
 * Apps can use the web-vitals library directly instead.
 */

interface WebVitalsMetric {
  id: string;
  name: string;
  value: number;
  rating?: "good" | "needs-improvement" | "poor";
  delta: number;
  navigationType?: "navigate" | "reload" | "back-forward" | "prerender";
}

type ReportWebVitalsCallback = (metric: WebVitalsMetric) => void;

/**
 * Register a callback to receive Core Web Vitals metrics.
 * No-op in our implementation — use the `web-vitals` library directly
 * for production metrics collection.
 */
export function useReportWebVitals(_callback: ReportWebVitalsCallback): void {
  // No-op — apps should use the web-vitals library directly
  // or their own analytics integration.
}

export type { WebVitalsMetric, ReportWebVitalsCallback };
