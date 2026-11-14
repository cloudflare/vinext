import { named } from "my-esm-package/exports";

export default function Page() {
  return <p id="server">{named}</p>;
}
