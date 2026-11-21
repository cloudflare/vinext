import { cache } from "react";
import { redirect } from "next/navigation";

// generateMetadata() and the page share one cached loader, so both throw the
// same redirect() error and a document request answers with a refresh meta
// tag. "/.//other.invalid/landing" is a path on this origin whose pathname is
// "//other.invalid/landing".
const load = cache(async (): Promise<never> => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  redirect("/.//other.invalid/landing");
});

export async function generateMetadata() {
  await load();
}

export default async function MetadataRedirectPage() {
  await load();
}
