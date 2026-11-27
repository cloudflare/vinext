import { unauthorized } from "next/navigation";

async function UnauthChild() {
  await new Promise((resolve) => setTimeout(resolve, 1));
  unauthorized();
}

export default function NestedUnauthPage() {
  return (
    <section id="notfound-sibling-slots-nested">
      <p>Nested page</p>
      <UnauthChild />
    </section>
  );
}
