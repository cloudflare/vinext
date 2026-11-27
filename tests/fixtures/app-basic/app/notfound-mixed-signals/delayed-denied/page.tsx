import { forbidden } from "next/navigation";

// The slot's notFound() rejects the document's shell before this does.
export default async function Page() {
  await new Promise((resolve) => setTimeout(resolve, 200));
  forbidden();
}
