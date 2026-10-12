import { HostCounter } from "./host-counter";
import { RemoteCounter } from "./remote-counter";

export default function Page() {
  return (
    <main>
      <h1>Module Federation host</h1>
      <HostCounter />
      <RemoteCounter />
    </main>
  );
}
