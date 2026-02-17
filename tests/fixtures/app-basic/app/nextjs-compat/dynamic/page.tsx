import { LazyClientComponent } from "./dynamic-imports/react-lazy-client";
import { NextDynamicClientComponent } from "./dynamic-imports/dynamic-client";
import {
  NextDynamicServerComponent,
  NextDynamicServerImportClientComponent,
} from "./dynamic-imports/dynamic-server";

export default function Page() {
  return (
    <div id="content">
      <LazyClientComponent />
      <NextDynamicServerComponent />
      <NextDynamicClientComponent />
      <NextDynamicServerImportClientComponent />
    </div>
  );
}
