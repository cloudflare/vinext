import { SlowCounter } from "./slow-counter";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>home</h1>
      <SlowCounter />
    </main>
  );
}
