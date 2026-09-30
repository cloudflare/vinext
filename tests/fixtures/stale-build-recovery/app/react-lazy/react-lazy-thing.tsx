import { useState } from "react";
import { VERSION } from "../version";

export default function ReactLazyThing() {
  const [count] = useState(0);

  return (
    <p id="react-lazy-thing">
      REACT_LAZY_MARKER {VERSION} {count}
    </p>
  );
}
