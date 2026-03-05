"use client";

import { useState, useEffect } from "react";
import { s } from "../_styles.js";

// Client-only component loaded via next/dynamic with ssr: false
export default function Clock() {
  const [time, setTime] = useState(new Date().toLocaleTimeString());

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date().toLocaleTimeString());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <p data-testid="clock" style={s.mono}>
      clock (dynamic, ssr: false): {time}
    </p>
  );
}
