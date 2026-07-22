export default function FocusTargetPage() {
  return (
    <>
      <textarea
        data-testid="segment-container"
        placeholder="Type here"
        style={{ height: "50vh", width: 120 }}
      />
      <div style={{ height: 10000, width: 10000 }} />
    </>
  );
}
