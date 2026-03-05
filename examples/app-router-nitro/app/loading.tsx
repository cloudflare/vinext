export default function Loading() {
  return (
    <div
      data-testid="loading"
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "3rem",
        color: "var(--muted)",
        fontSize: "0.9rem",
      }}
    >
      Loading...
    </div>
  );
}
