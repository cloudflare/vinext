import { notFound, redirect } from "next/navigation";

export default async function TeamDashboardPage(props: { params: Promise<{ teamSlug: string }> }) {
  const params = await props.params;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const username = "vercel-user";
  if (params.teamSlug === username) {
    return redirect("/");
  }

  return notFound();
}

export const dynamicParams = true;

export async function generateMetadata() {
  return {
    title: "test",
  };
}
