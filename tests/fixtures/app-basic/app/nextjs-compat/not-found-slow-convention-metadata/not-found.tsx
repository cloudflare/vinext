// A slow generateMetadata() on the not-found convention must not hold back the
// 404 for a browser, as Next.js streams its error shell's metadata.
export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  return { title: "Slow convention not found" };
}

export default function NotFound() {
  return <p id="slow-convention-not-found">Slow convention not found boundary</p>;
}
