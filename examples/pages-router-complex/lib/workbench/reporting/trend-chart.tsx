import dynamic from "next/dynamic";

import { axisTicks, scaleTo } from "./shared-axis";

// A lazy chunk that loads another lazy chunk once it renders in the browser.
const TrendLegend = dynamic(() => import("./trend-legend"), {
  ssr: false,
  loading: () => <p data-testid="trend-legend-loading">Loading legend…</p>,
});

/** Loaded through next/dynamic with SSR, so its chunk is preloaded. */
const TrendChart = ({ series }: { series: readonly number[] }) => {
  const max = Math.max(...series);
  return (
    <figure data-testid="trend-chart">
      <svg width="200" height="100" role="img" aria-label="Trend">
        {series.map((value, index) => (
          <rect
            key={index}
            x={index * 20}
            y={100 - scaleTo(value, max)}
            width="16"
            height={scaleTo(value, max)}
          />
        ))}
      </svg>
      <figcaption>Ticks: {axisTicks(max).join(" / ")}</figcaption>
      <TrendLegend labels={series.map((_, index) => `W${index + 1}`)} />
    </figure>
  );
};

export default TrendChart;
