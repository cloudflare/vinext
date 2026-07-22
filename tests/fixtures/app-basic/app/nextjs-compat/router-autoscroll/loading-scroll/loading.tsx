export default function Loading() {
  return (
    <>
      <div id="loading-component">Loading component</div>
      <div style={{ height: 1, width: 10000 }} />
      {Array.from({ length: 500 }, (_, index) => (
        <div key={index}>Loading {index}...</div>
      ))}
    </>
  );
}
