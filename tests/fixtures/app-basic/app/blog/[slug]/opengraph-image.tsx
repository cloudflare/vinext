// Dynamic OG image in a dynamic segment — returns a plain Response
// to avoid Satori/Resvg dependencies in the test environment.
import { notFound, redirect } from "next/navigation";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";

export const alt = "Blog post open graph image";

export default async function OGImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (slug === "missing") notFound();
  if (slug === "moved") redirect("/blog/hello-world/opengraph-image");
  return new Response(`og:${slug}`, {
    headers: { "Content-Type": "image/png" },
  });
}
