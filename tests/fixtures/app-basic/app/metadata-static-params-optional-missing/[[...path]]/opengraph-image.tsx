export const dynamicParams = false;

export function generateStaticParams() {
  return [{}];
}

export default function OpenGraphImage() {
  return new Response("MISSING OPTIONAL", {
    headers: { "content-type": "text/plain" },
  });
}
