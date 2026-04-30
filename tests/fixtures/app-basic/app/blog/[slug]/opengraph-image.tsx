// Dynamic OG image in a dynamic segment — returns a plain Response
// to avoid Satori/Resvg dependencies in the test environment.
export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";

export const alt = "Blog post open graph image";

export default async function OGImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(`og:${slug}`, {
    headers: { "Content-Type": "image/png" },
  });
}
