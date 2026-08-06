export function NoInline() {
  return (
    <div style={{ display: "none" }}>
      {Array.from({ length: 256 }, (_, index) => (
        <span key={index}>Hidden content to keep this segment outlined. </span>
      ))}
    </div>
  );
}
