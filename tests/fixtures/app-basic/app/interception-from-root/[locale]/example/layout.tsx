import { ReactNode } from "react";

export default function ExampleLayout({
  children,
  modal,
}: {
  children: ReactNode;
  modal: ReactNode;
}) {
  return (
    <div>
      {children}
      {modal}
    </div>
  );
}
