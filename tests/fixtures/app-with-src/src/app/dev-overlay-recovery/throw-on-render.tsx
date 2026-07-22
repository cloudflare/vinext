"use client";

export function ThrowOnRender() {
  throw new ReferenceError("dev-overlay-recovery: bare-bones render failure");
}
