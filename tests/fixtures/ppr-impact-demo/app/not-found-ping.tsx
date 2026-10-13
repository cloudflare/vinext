"use client";

import { useState } from "react";
import { ping } from "./not-found-actions";

export function NotFoundPing() {
  const [reply, setReply] = useState("");
  return (
    <p>
      <button id="not-found-ping" onClick={async () => setReply(await ping())}>
        Ping
      </button>
      <output id="not-found-ping-reply">{reply}</output>
    </p>
  );
}
