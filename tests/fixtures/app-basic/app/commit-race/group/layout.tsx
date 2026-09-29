import { cookies } from "next/headers";
import { LayoutHold } from "./layout-hold";

export default async function CommitRaceGroupLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const mode = jar.get("commit-race-mode")?.value === "ready" ? "ready" : "hold";

  return (
    <section data-testid="group-layout" data-mode={mode}>
      <LayoutHold mode={mode} />
      {children}
    </section>
  );
}
