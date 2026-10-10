"use client";

import * as React from "react";
import { getVinextReact } from "vinext/client";

const { useState } = getVinextReact(React);

export default function RemoteCounter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((value) => value + 1)}>Remote counter: {count}</button>;
}
