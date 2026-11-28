import { useEffect, useRef } from "react";
import { onCLS, onFID, onLCP, onINP, onFCP, onTTFB, type MetricType } from "web-vitals";

type WebVitalsMetric = MetricType;
type ReportWebVitalsCallback = (metric: WebVitalsMetric) => void;

export function useReportWebVitals(callback: ReportWebVitalsCallback): void {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const reportWebVitals = (metric: WebVitalsMetric) => {
      callbackRef.current(metric);
    };

    onCLS(reportWebVitals);
    onFID(reportWebVitals);
    onLCP(reportWebVitals);
    onINP(reportWebVitals);
    onFCP(reportWebVitals);
    onTTFB(reportWebVitals);
  }, []);
}

export type { WebVitalsMetric, ReportWebVitalsCallback };

// `next/web-vitals` is CommonJS in Next.js, so a default import receives its
// `module.exports`: the entry's public API (packages/next/src/client/web-vitals.ts).
export default {
  useReportWebVitals,
};
