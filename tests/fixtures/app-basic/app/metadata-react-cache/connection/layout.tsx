import { getLive } from "../data";

export default async function Layout({ children }: { children: React.ReactNode }) {
  const live = await getLive();
  return (
    <section>
      <p id="live">{live}</p>
      {children}
    </section>
  );
}
