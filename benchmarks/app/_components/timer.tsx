"use client";
import { useState, useEffect } from "react";

export function Timer() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <span>Uptime: {elapsed}s</span>;
}

