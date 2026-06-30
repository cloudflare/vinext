import { cookies } from "next/headers";

export const dynamic = "error";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id.includes("static-bailout")) {
    await cookies();
  }
  return <p>Dynamic error</p>;
}
