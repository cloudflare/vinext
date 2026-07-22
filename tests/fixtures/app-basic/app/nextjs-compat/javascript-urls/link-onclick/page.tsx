"use client";

import { useState } from "react";
import Link from "next/link";
import { DANGEROUS_JAVASCRIPT_URL } from "../bad-url";

export default function Page() {
  const [clicks, setClicks] = useState(0);

  return (
    <>
      <p id="click-count">clicks: {clicks}</p>
      <Link
        id="unsafe-link"
        href={DANGEROUS_JAVASCRIPT_URL}
        onClick={() => {
          setClicks((value) => value + 1);
        }}
      >
        unsafe link with custom click handler
      </Link>
    </>
  );
}
