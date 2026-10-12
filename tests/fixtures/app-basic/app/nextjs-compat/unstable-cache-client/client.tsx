"use client";

import { unstable_cache } from "next/cache";
import { useEffect, useState } from "react";

// Next.js lets Client Components import unstable_cache, where it calls the
// callback without caching.
const getGreeting = unstable_cache(async (name: string) => `hello ${name}`, ["client-greeting"]);

export function ClientGreeting() {
  const [greeting, setGreeting] = useState("pending");
  useEffect(() => {
    void getGreeting("client").then(setGreeting);
  }, []);
  return <p data-testid="client-greeting">{greeting}</p>;
}
