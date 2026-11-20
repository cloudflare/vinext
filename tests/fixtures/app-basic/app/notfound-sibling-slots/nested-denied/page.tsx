import { forbidden } from "next/navigation";

function DeniedChild() {
  forbidden();
}

export default function NestedDeniedPage() {
  return (
    <section id="notfound-sibling-slots-nested">
      <p>Nested page</p>
      <DeniedChild />
    </section>
  );
}
