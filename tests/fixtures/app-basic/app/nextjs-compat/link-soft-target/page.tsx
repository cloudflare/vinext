export const revalidate = 0;

export default function Page() {
  return <h1 data-testid="soft-push-render-id">{crypto.randomUUID()}</h1>;
}
