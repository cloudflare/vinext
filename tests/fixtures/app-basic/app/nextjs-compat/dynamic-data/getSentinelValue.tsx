export function getSentinelValue() {
  return "at runtime";
}

export function LayoutSentinel() {
  return <div id="layout">{getSentinelValue()}</div>;
}

export function PageSentinel() {
  return <div id="page">{getSentinelValue()}</div>;
}
