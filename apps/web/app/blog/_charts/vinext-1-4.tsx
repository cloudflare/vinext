"use client";

import { ByteBars, Highlights, MetricPanels, ScoreRings, type Metric } from "./benchmark-charts";
import { formatMs, type Format } from "./primitives";

/**
 * Benchmark charts for the Vinext 1.4 post. The numbers come from the 2026-10-28 runs
 * of the Hacker News app from solid-server-component-benchmarks and a content site prototype.
 * "Vinext 1.4" is a build of main at f938be86.
 */

const formatMb: Format = (value) => `${Math.round(value)} MB`;
const formatRps: Format = (value) => `${value.toFixed(1)}/s`;
const formatKb: Format = (value) => `${Math.round(value)} kB`;
const formatScore: Format = (value) => String(value);

const HN_SERVERS = (
  <>
    Every server ran the same Hacker News app on Node 24.22.1 behind the benchmark&apos;s brotli
    front proxy: Vinext 1.3.0 from npm, Vinext main at <code>f938be86</code>, and Next.js 16.4.2
    with <code>next start</code>. The story page has about 1,500 comments and renders on every
    request.
  </>
);

export function HighlightsChart() {
  return (
    <Highlights
      eyebrow="Hacker News story page"
      title="Vinext 1.4 against 1.3 and Next.js"
      highlights={[
        {
          label: "Server CPU per request",
          value: "−43%",
          detail: "54.4 ms in 1.3, 31.1 ms in 1.4. Next.js uses 33.7 ms.",
          steps: { v13: 54.4, v14: 31.1, next: 33.7 },
          format: formatMs,
          better: "lower",
        },
        {
          label: "Script time on page load",
          value: "−26%",
          detail: "193 ms in 1.3, 143 ms in 1.4. Next.js uses 150 ms.",
          steps: { v13: 193, v14: 143, next: 150 },
          format: formatMs,
          better: "lower",
        },
        {
          label: "Lighthouse mobile score",
          value: "88",
          detail: "Up from 81 in 1.3. Next.js scores 87.",
          steps: { v13: 81, v14: 88, next: 87 },
          format: formatScore,
          better: "higher",
        },
      ]}
      method={
        <>
          {HN_SERVERS} Server CPU is process-tree CPU time per request under a closed loop of 8
          concurrent clients. Script time is headless Chromium with a 4× CPU throttle, the median of
          8 loads. The Lighthouse score is the median of 5 mobile runs. The sections below have the
          details for each.
        </>
      }
    />
  );
}

const HN_SERVER_METRICS: Metric[] = [
  {
    label: "CPU per request",
    better: "lower",
    format: formatMs,
    values: { v13: 54.4, v14: 31.1, next: 33.7 },
  },
  {
    label: "Throughput",
    better: "higher",
    format: formatRps,
    values: { v13: 16.3, v14: 22.9, next: 21.3 },
  },
  {
    label: "Median response time",
    better: "lower",
    format: formatMs,
    values: { v13: 480.8, v14: 343.9, next: 372.1 },
  },
  {
    label: "Peak memory",
    better: "lower",
    format: formatMb,
    values: { v13: 743.9, v14: 672.8, next: 688.7 },
  },
];

export function HackerNewsServerChart() {
  return (
    <MetricPanels
      eyebrow="Hacker News · server"
      title="Rendering a 1,500-comment story under load"
      metrics={HN_SERVER_METRICS}
      method={
        <>
          {HN_SERVERS} A closed loop of 8 concurrent clients requested the story page for 3 rounds
          of 20 seconds per server. CPU and memory cover the whole process tree. The upstream Hacker
          News API delay is 150 ms, which is included in response times. The machine was shared,
          with a load average of 4.7–7.4, so the servers were interleaved to spread the noise
          evenly.
        </>
      }
    />
  );
}

const HN_BROWSER_METRICS: Metric[] = [
  {
    label: "Script time on load",
    better: "lower",
    format: formatMs,
    values: { v13: 193, v14: 143, next: 150 },
  },
  {
    label: "Main-thread work on load",
    better: "lower",
    format: formatMs,
    values: { v13: 706, v14: 609, next: 706 },
  },
  {
    label: "Largest Contentful Paint",
    better: "lower",
    format: formatMs,
    values: { v13: 712, v14: 628, next: 668 },
  },
  {
    label: "Script time, client navigation",
    better: "lower",
    format: formatMs,
    values: { v13: 182.4, v14: 146.5, next: 155.4 },
  },
];

export function HackerNewsBrowserChart() {
  return (
    <MetricPanels
      eyebrow="Hacker News · browser"
      title="Loading and navigating to the same story"
      metrics={HN_BROWSER_METRICS}
      method={
        <>
          {HN_SERVERS} Headless Chromium with a 4× CPU throttle loaded the story page 8 times per
          server, alternating the order. Client navigation clicks from the feed to the story and
          measures until more than 1,000 comments have painted, 7 runs per server. All values are
          medians.
        </>
      }
    />
  );
}

export function HackerNewsLighthouseChart() {
  return (
    <ScoreRings
      eyebrow="Hacker News · Lighthouse"
      title="Mobile Lighthouse on the story page"
      runs={{
        v13: { score: 81, fcp: 3307, lcp: 3765, tbt: 110 },
        v14: { score: 88, fcp: 2106, lcp: 3687, tbt: 56 },
        next: { score: 87, fcp: 2256, lcp: 3639, tbt: 91 },
      }}
      method={
        <>
          {HN_SERVERS} Lighthouse&apos;s default mobile preset simulates a slow 4G connection and a
          4× slower CPU. Each value is the median of 5 runs, each in a fresh Chromium. Simulated
          paint times move in steps of about 150 ms, one simulated round trip, so a gap that small
          isn&apos;t a real difference.
        </>
      }
    />
  );
}

const REDACT_METRICS: Metric[] = [
  {
    label: "JavaScript downloaded",
    better: "lower",
    format: formatKb,
    values: { v14: 143.3, redact: 107.7 },
  },
  {
    label: "Script time, front page",
    better: "lower",
    format: formatMs,
    values: { v14: 51, redact: 14 },
  },
  {
    label: "Script time, story page",
    better: "lower",
    format: formatMs,
    values: { v14: 143, redact: 264 },
  },
  {
    label: "Lighthouse Total Blocking Time",
    better: "lower",
    format: formatMs,
    values: { v14: 56, redact: 666 },
  },
  {
    label: "Script time, client navigation",
    better: "lower",
    format: formatMs,
    values: { v14: 146.5, redact: 235.4 },
  },
];

export function RedactChart() {
  return (
    <MetricPanels
      eyebrow="Hacker News · TanStack Redact"
      title="Hacker News with Redact in the browser"
      metrics={REDACT_METRICS}
      series={["v14", "redact"]}
      labels={{ redact: "With Redact" }}
      comparison={{ from: "v14", to: "redact", caption: "with Redact" }}
      method={
        <>
          {HN_SERVERS} The Redact build adds <code>@tanstack/redact</code> 0.2.2 with{" "}
          <code>redact()</code> from <code>@tanstack/redact/vinext</code>, which only accepts Vinext
          1.3.0, so its version check was bypassed for the run. Server numbers stayed within noise
          (31.1 ms against 30.4 ms of CPU per request), since Redact only changes the browser
          runtime. Script time is headless Chromium with a 4× CPU throttle, the median of 8 loads of
          each page; client navigation is the median of 7 clicks from the front page to the story.
          The front page lists 30 stories from the live Hacker News API. JavaScript downloaded and
          Total Blocking Time come from the median of 5 mobile Lighthouse runs.
        </>
      }
    />
  );
}

const CONTENT_SITE_SERVERS = (
  <>
    A prototype of a large content site, with its page routes set to <code>force-dynamic</code> so
    every request renders. Vinext 1.3.0 and main ran under local workerd with{" "}
    <code>vite preview</code>, and Next.js 16.2.6 ran on Node with <code>next start</code>, on an
    Apple M4 Pro. The two runtimes differ, so compare the Vinext versions with each other first.
  </>
);

const CONTENT_SITE_METRICS: Metric[] = [
  {
    label: "First Contentful Paint",
    better: "lower",
    format: formatMs,
    values: { v13: 2542, v14: 1672, next: 1209 },
  },
  {
    label: "Lighthouse score",
    better: "higher",
    format: formatScore,
    values: { v13: 80, v14: 84, next: 80 },
  },
  {
    label: "Script time on load",
    better: "lower",
    format: formatMs,
    values: { v13: 245, v14: 191, next: 220 },
  },
  {
    label: "JavaScript downloaded",
    better: "lower",
    format: formatKb,
    values: { v13: 382.3, v14: 381.8, next: 623.3 },
  },
  {
    label: "Server CPU per request",
    better: "lower",
    format: formatMs,
    values: { v13: 132.9, v14: 130.3, next: 102.5 },
  },
  {
    label: "Peak server memory",
    better: "lower",
    format: formatMb,
    values: { v13: 1016.6, v14: 967.7, next: 2192.7 },
  },
];

export function ContentSiteChart() {
  return (
    <MetricPanels
      eyebrow="Content site prototype"
      title="A large content site, rendered on every request"
      metrics={CONTENT_SITE_METRICS}
      method={
        <>
          {CONTENT_SITE_SERVERS} First Contentful Paint, the Lighthouse score and JavaScript
          downloaded come from Lighthouse 12.8.2&apos;s mobile preset. Script time is headless
          Chromium with a 4× CPU throttle, 8 loads of each of 4 pages. Server numbers come from a
          closed loop of 8 concurrent clients over 8 pages, 3 rounds of 20 seconds per server.
          Renders fetch data over the network, so response times carry network noise.
        </>
      }
    />
  );
}

export function ContentSitePrefetchChart() {
  return (
    <ByteBars
      eyebrow="Content site prototype · prefetch"
      title="What the browser prefetches after opening one page"
      rows={[
        { id: "v13", bytes: 3_897_889, requests: 13 },
        { id: "v14", bytes: 10_723, requests: 13 },
        { id: "next", bytes: 0, requests: 1, note: "One route-tree request" },
      ]}
      method={
        <>
          {CONTENT_SITE_SERVERS} Bytes are the uncompressed bodies of the RSC requests the page
          issues for the links it shows, within 4 seconds of loading and without throttling.
        </>
      }
    />
  );
}
