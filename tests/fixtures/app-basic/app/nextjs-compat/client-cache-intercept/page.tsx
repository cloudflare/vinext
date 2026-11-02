import Link from "next/link";

export default function ClientCacheInterceptHome() {
  return (
    <div id="client-cache-intercept-home">
      <Link
        href="/nextjs-compat/client-cache-intercept-static/1"
        id="client-cache-intercept-static-link"
      >
        static target, dynamic modal
      </Link>
      <Link
        href="/nextjs-compat/client-cache-intercept-dynamic/1"
        id="client-cache-intercept-dynamic-link"
      >
        dynamic target, static modal
      </Link>
    </div>
  );
}
