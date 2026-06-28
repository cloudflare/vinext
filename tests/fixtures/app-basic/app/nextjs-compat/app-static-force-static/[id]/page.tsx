import { cookies, headers } from "next/headers";

export const dynamic = "force-static";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main>
      <p id="route">/nextjs-compat/app-static-force-static</p>
      <p id="id">{id}</p>
      <p id="headers">{JSON.stringify([...(await headers()).entries()])}</p>
      <p id="cookies">{JSON.stringify((await cookies()).getAll())}</p>
    </main>
  );
}
