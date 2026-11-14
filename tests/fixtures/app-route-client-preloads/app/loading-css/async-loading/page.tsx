import { Viewer } from "../viewer";

export const dynamic = "force-dynamic";

// The page renders after loading.tsx's fallback has flushed with the shell.
export default async function Page() {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return <Viewer />;
}
