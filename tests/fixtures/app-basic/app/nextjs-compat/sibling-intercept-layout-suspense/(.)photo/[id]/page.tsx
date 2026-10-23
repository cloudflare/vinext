import { cache, use } from "react";

const getPhoto = cache(async (id: string) => {
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  return `Photo ${id}`;
});

// A synchronous page that suspends with use(), without loading.tsx.
export default function InterceptedPhoto({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const photo = use(getPhoto(id));
  return <p id="sibling-intercept-layout-suspense-intercepted">Intercepted: {photo}</p>;
}
