"use client";

import { useState } from "react";
import styles from "./consent-banner.module.css";

export default function ConsentBanner() {
  const [accepted, setAccepted] = useState(false);
  const [details, setDetails] = useState("");
  return (
    <div className={styles.banner} data-testid="consent-banner">
      <button type="button" onClick={() => setAccepted(true)}>
        {accepted ? "Accepted" : "Accept cookies"}
      </button>
      <button
        type="button"
        onClick={async () => setDetails((await import("./cookie-banner")).cookieDetails)}
      >
        Load details
      </button>
      <p data-testid="cookie-details">{details}</p>
    </div>
  );
}
