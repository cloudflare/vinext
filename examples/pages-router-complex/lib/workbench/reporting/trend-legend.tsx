/** Nested lazy chunk: only the trend chart's lazy chunk imports it. */
const TrendLegend = ({ labels }: { labels: readonly string[] }) => (
  <ul data-testid="trend-legend">
    {labels.map((label) => (
      <li key={label}>{label}</li>
    ))}
  </ul>
);

export default TrendLegend;
