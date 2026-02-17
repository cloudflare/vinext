// This server component throws — the child error.tsx should catch it,
// NOT the parent error.tsx
export default function ErrorNestedChildPage() {
  throw new Error("Nested child error");
  return <div>Never rendered</div>;
}
