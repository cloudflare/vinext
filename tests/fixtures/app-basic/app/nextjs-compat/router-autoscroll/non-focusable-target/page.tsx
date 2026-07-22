export default function NonFocusableTargetPage() {
  return (
    <>
      <div data-testid="non-focusable-target">Non-focusable target</div>
      <div style={{ height: 1, width: 10000 }} />
      {Array.from({ length: 500 }, (_, index) => (
        <div key={index}>Non-focusable target row {index}</div>
      ))}
    </>
  );
}
