import Link from "next/link";
import { LayoutEffectHistoryWrite } from "./layout-effect-history-write";

export default function ShallowHistoryLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <LayoutEffectHistoryWrite />
      <Link href="/nextjs-compat/shallow-history/target" id="to-shallow-history-target">
        Target
      </Link>
      {children}
    </>
  );
}
