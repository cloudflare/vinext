import type { CSSProperties } from "react";

function skippedElementStyle(kind: string): CSSProperties {
  switch (kind) {
    case "display-none":
      return { display: "none" };
    case "fixed":
      return {
        background: "white",
        height: 40,
        left: 0,
        position: "fixed",
        top: 32,
      };
    case "sticky":
      return {
        background: "white",
        height: 40,
        position: "sticky",
        top: 32,
      };
    default:
      return { display: "none" };
  }
}

export default async function SkippedTargetPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;

  return (
    <>
      <div data-testid="skipped-target" style={skippedElementStyle(kind)}>
        Skipped target: {kind}
      </div>
      <button
        data-testid="selected-scroll-target"
        style={{
          display: "block",
          height: 44,
          marginLeft: 1000,
          width: 260,
        }}
      >
        Selected target: {kind}
      </button>
      <div style={{ height: 1, width: 10000 }} />
      {Array.from({ length: 500 }, (_, index) => (
        <div key={index}>Skipped target row {index}</div>
      ))}
    </>
  );
}
