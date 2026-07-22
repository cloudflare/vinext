"use client";

import { useReportWebVitals } from "next/web-vitals";

const vitalsUrl = "https://example.vercel.sh/vitals";

export default function Reporter() {
  useReportWebVitals((metric) => {
    fetch(vitalsUrl, {
      body: new URLSearchParams({ name: metric.name, value: String(metric.value) }),
      credentials: "omit",
      keepalive: true,
      method: "POST",
    });
  });

  return null;
}
