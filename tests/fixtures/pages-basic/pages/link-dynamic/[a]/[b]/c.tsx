import { useRouter } from "next/router";

export default function DynamicObjectLinkTarget() {
  const router = useRouter();

  return (
    <main>
      <h1>Dynamic object Link target</h1>
      <p data-testid="dynamic-object-params">
        {router.query.a}/{router.query.b}/{router.query.q}
      </p>
    </main>
  );
}
