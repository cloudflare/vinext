import ClientComponent from "./client-component";

export default function Page() {
  return (
    <div>
      <h1>Server Only Violation Test</h1>
      <ClientComponent />
    </div>
  );
}
