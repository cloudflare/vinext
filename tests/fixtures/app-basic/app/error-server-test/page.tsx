// Server Component that always throws during render
export default function ErrorServerTestPage() {
  throw new Error("Server component error");
  return <div>This should never render</div>;
}
