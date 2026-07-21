import { useRouter } from "next/router";

type Props = {
  hit: number;
};

const COUNTER_KEY = Symbol.for("vinext.tests.gsspDedupCounter");

type CounterGlobal = typeof globalThis & {
  [COUNTER_KEY]?: number;
};

export default function GsspDedupSlow({ hit }: Props) {
  const router = useRouter();
  return (
    <main>
      <h1>a slow page</h1>
      <p data-testid="hit">hit: {hit}</p>
      <p data-testid="key">key: {String(router.query.key ?? "")}</p>
    </main>
  );
}

export async function getServerSideProps() {
  const counterGlobal = globalThis as CounterGlobal;
  counterGlobal[COUNTER_KEY] = (counterGlobal[COUNTER_KEY] ?? 0) + 1;
  const hit = counterGlobal[COUNTER_KEY];
  await new Promise((resolve) => setTimeout(resolve, 300));

  return {
    props: {
      hit,
    },
  };
}
