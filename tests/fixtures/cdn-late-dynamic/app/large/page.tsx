export const revalidate = 60;

export default function Page() {
  return <main>{"x".repeat(1024 * 1024 + 64 * 1024)}</main>;
}
