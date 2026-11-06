import { Counter } from "./counter";

// A slot page's redirect() to a sibling route must keep this layout's client
// state, as in Next.js.
export default function Layout({ children, s }: { children: React.ReactNode; s: React.ReactNode }) {
  return (
    <main>
      <Counter />
      {children}
      <section>{s}</section>
    </main>
  );
}
