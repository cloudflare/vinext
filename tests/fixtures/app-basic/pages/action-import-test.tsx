// Ported (in spirit) from Next.js fixture:
// test/e2e/app-dir/action-in-pages-router/pages/foo.tsx
//
// A Pages Router page importing a function from a `"use server"` module.
// Pages Router does not support Server Actions — the call must return the
// real string, not be turned into a server-reference proxy. Regression test
// for https://github.com/cloudflare/vinext/issues/1476.
import { actionFoo } from "../lib/pages-fake-action";

type Props = { result: string };

export default function ActionImportTest({ result }: Props) {
  return <div data-testid="action-result">{result}</div>;
}

export async function getServerSideProps(): Promise<{ props: Props }> {
  const result = await actionFoo();
  return { props: { result } };
}
