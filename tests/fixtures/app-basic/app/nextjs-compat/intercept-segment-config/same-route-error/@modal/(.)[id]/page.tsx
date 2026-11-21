import { cookies } from "next/headers";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = (await cookies()).get("intercept-config")?.value;
  return (
    <p id="intercept-config-intercepted">
      same-route-error intercept {id} cookie={String(cookie)}
    </p>
  );
}
