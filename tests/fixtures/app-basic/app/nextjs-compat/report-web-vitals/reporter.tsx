"use client";

import { useReportWebVitals, type WebVitalsMetric } from "next/web-vitals";

const vitalsUrl = "https://example.vercel.sh/vitals";

export default function Reporter() {
  useReportWebVitals((metric: WebVitalsMetric) => {
    fetch(vitalsUrl, {
      body: new URLSearchParams({ name: metric.name, value: String(metric.value) }),
      credentials: "omit",
      keepalive: true,
      method: "POST",
    });
  });

  return null;
}
