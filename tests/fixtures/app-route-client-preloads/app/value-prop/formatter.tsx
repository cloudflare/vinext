"use client";

export function Formatter({ format }: { format: (value: number) => string }) {
  return (
    <p data-testid="formatted">
      {typeof format === "function" ? format(42) : `not a function: ${typeof format}`}
    </p>
  );
}
