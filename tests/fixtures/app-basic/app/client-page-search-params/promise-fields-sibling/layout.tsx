import type { ReactNode } from "react";

// Two client pages in one render: the page unwraps its searchParams first,
// then the @fields slot's page reads React's promise fields off its own.
export default function PromiseFieldsSiblingLayout({
  children,
  fields,
}: {
  children: ReactNode;
  fields: ReactNode;
}) {
  return (
    <>
      {children}
      {fields}
    </>
  );
}
