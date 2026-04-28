import { describe, expect, it } from "vitest";
import { stripServerExports } from "../packages/vinext/src/plugins/strip-server-exports.js";

describe("stripServerExports import pruning", () => {
  it("removes imports used only by stripped Pages data exports", () => {
    // Ported from Next.js: test/e2e/prerender-native-module.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/prerender-native-module.test.ts
    const code = `
import path from 'path'
import { open } from 'sqlite'
import sqlite3 from 'sqlite3'
import { useRouter } from 'next/router'

export const getStaticProps = async () => {
  const dbPath = path.join(process.cwd(), 'data.sqlite')
  const db = await open({ filename: dbPath, driver: sqlite3.Database })
  return { props: { users: await db.all('SELECT * FROM users') } }
}

export default function Page() {
  const router = useRouter()
  return router.isFallback ? 'Loading...' : 'ready'
}
`;

    const result = stripServerExports(code);

    expect(result).not.toBeNull();
    expect(result).not.toContain("from 'path'");
    expect(result).not.toContain("from 'sqlite'");
    expect(result).not.toContain("from 'sqlite3'");
    expect(result).toContain("from 'next/router'");
    expect(result).toContain("export const getStaticProps = undefined;");
  });
});
