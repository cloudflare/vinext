import Link from "next/link";
import { EffectProbe } from "../effect-probe";

const base = "/bfcache-effects/panels";

export default function PanelsLayout({
  children,
  panel,
}: {
  children: React.ReactNode;
  panel: React.ReactNode;
}) {
  return (
    <section>
      <EffectProbe name="panels-layout" />
      <Link href={base}>Panels</Link>
      {["a", "b", "c", "d"].map((id) => (
        <Link key={id} href={`${base}/${id}`}>
          Panel {id}
        </Link>
      ))}
      <div>{children}</div>
      <aside>{panel}</aside>
    </section>
  );
}
