import { SlowCounter } from "./slow-counter";
import { First } from "./siblings/first";
import { Second } from "./siblings/second";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>home</h1>
      <SlowCounter />
      <First />
      <Second />
    </main>
  );
}
