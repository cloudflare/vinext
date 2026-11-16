import { useEffect, useState } from "react";

import { formatMinutes } from "../format/durations";

/** Loaded through next/dynamic with `ssr: false`: browser only. */
const LiveTicker = () => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <p data-testid="live-ticker">Live for {formatMinutes(elapsed)}</p>;
};

export default LiveTicker;
