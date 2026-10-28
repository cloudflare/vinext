import { named } from "my-barrel-package";
import Client from "./client";

export default function Page() {
  return (
    <main>
      <p id="server">{named}</p>
      <Client />
    </main>
  );
}
