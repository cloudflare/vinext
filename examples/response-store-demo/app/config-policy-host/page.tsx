import { headers } from "next/headers";

export const revalidate = 60;

// next.config gives this page a public provider policy, but reading the host
// is a dynamic API, so no host's render goes in the entry every host shares.
export default async function ConfigPolicyHostPage() {
  const host = (await headers()).get("host");
  return (
    <main>
      <p data-testid="host">{host}</p>
      <p data-testid="render-id">{crypto.randomUUID()}</p>
    </main>
  );
}
