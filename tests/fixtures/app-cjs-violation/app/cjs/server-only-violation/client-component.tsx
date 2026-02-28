"use client";

import { getSecret } from "./server-lib";

export default function ClientComponent() {
  return <div data-testid="violation-result">Secret: {getSecret()}</div>;
}
