import { connection } from "next/server";

export function generateStaticParams() {
  return [{ param: "a" }, { param: "b" }];
}

export default async function Page({ params }: { params: Promise<{ param: string }> }) {
  await connection();
  const { param } = await params;
  await new Promise((resolve) => setTimeout(resolve, 500));
  return <div id={`dynamic-page-content-${param}`}>{`Dynamic page ${param}`}</div>;
}
