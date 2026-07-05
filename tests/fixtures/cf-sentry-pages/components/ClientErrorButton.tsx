"use client";

export function ClientErrorButton() {
  return (
    <button
      type="button"
      onClick={() => {
        setTimeout(() => {
          throw new Error("Intentional Sentry Pages Router client error");
        });
      }}
    >
      Trigger client error
    </button>
  );
}
