import ClientComponent from "./client-component";

export default function PrefetchFalseLoadingNestedPage() {
  return (
    <div id="nested-testing-page">
      <p>Testing/Test Page</p>
      <ClientComponent />
    </div>
  );
}
