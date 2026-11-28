"use client";

// A Client Component that also loads a module with require(). The CommonJS
// conversion must keep the directive first, or it stops being a directive.
import { useState } from "react";

const greeting = require("../cases/greeting.js");

export function RequireClient() {
  const [count] = useState(1);
  return (
    <p data-testid="require-client">
      {greeting.text} {count}
    </p>
  );
}
