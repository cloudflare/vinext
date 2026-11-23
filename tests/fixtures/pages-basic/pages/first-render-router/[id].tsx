import { useRouter } from "next/router";

type RenderRecord = {
  query: Record<string, unknown>;
  pathname: string;
  asPath: string;
  location: string;
};

export const getServerSideProps = async () => ({ props: {} });

export default function FirstRenderRouterItem() {
  const router = useRouter();
  if (typeof window !== "undefined") {
    const w = window as unknown as { __FIRST_RENDER_ROUTER__?: RenderRecord[] };
    (w.__FIRST_RENDER_ROUTER__ ??= []).push({
      query: { ...router.query },
      pathname: router.pathname,
      asPath: router.asPath,
      location: window.location.pathname,
    });
  }
  return (
    <div>
      <p data-testid="first-render-id">{String(router.query.id)}</p>
      <button
        data-testid="first-render-push"
        onClick={() => void router.push("/first-render-router/2")}
      >
        push /first-render-router/2
      </button>
    </div>
  );
}
