"use client";

import { useState } from "react";

export default function Dynamic() {
  const [state] = useState("dynamic on client");
  return <p id="css-text-dynamic-client">{`next-dynamic ${state}`}</p>;
}
