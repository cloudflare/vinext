import { DynamicHost } from "./dynamic-host";

export default function DynamicPage() {
  return (
    <main>
      <h1 id="target">Dynamic page</h1>
      <DynamicHost />
    </main>
  );
}
