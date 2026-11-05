import { runtimeName } from "./runtime.js";

export default function Page() {
  return <div data-testid="cjs-dead-require">{runtimeName()}</div>;
}
