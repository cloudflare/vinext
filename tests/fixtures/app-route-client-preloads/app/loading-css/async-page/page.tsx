import { Viewer } from "../viewer";

export const dynamic = "force-dynamic";

export default async function Page() {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return <Viewer />;
}
