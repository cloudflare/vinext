"use client";

export function BrokenClient() {
  throw new ReferenceError("dev-overlay-broken: client render failure");
}
