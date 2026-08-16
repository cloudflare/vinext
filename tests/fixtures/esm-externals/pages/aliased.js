import React from "preact/compat";
import { World1, World2, World3 } from "@shared/pages-worlds.js";

export default function Page() {
  return (
    <p>
      Aliased {World1}+{World2}+{World3}
    </p>
  );
}
