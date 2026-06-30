export const dynamic = "force-dynamic";

export default function RenderErrorPage() {
  throw new Error("Intentional Sentry App Router render error");
}
