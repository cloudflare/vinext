import { notFound } from "next/navigation";

async function MissingChild() {
  await new Promise((resolve) => setTimeout(resolve, 1));
  notFound();
}

export default async function NestedMissingPage() {
  return (
    <section id="notfound-sibling-slots-nested">
      <p>Nested page</p>
      <MissingChild />
    </section>
  );
}
