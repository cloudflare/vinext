export default function ScrollableSegmentPage() {
  return (
    <div
      data-testid="segment-container"
      style={{
        height: "50vh",
        overflow: "scroll",
        width: 260,
      }}
    >
      <div style={{ height: "60vh" }}>Scroll me</div>
    </div>
  );
}
