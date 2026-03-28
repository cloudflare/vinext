import { FakeComponent } from "fake-css-lib";
import { ModComponent } from "fake-css-module-lib";

export default function Page() {
  return (
    <div>
      <h1 id="nm-css-test">node-modules-css-works</h1>
      <p>{FakeComponent()}</p>
      <p>{ModComponent()}</p>
    </div>
  );
}
