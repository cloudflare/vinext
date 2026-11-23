import type { ReactNode } from "react";

export default function SlotLayout({ children, panel }: { children: ReactNode; panel: ReactNode }) {
  return (
    <section>
      {children}
      <aside>{panel}</aside>
    </section>
  );
}
