import Link from "next/link";

export default function FirstRenderRouterHome() {
  return (
    <Link href="/first-render-router/1" data-testid="first-render-link">
      go to /first-render-router/1
    </Link>
  );
}
