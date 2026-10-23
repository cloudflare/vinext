import type { ReactNode } from "react";

// b's own loading.tsx wraps this layout's slot as well as its page.
export default function SlotLayout({ children, side }: { children: ReactNode; side: ReactNode }) {
  return (
    <div>
      {children}
      <aside>{side}</aside>
    </div>
  );
}
