import dynamic from "next/dynamic";

// The page reaches its font only through a component it loads lazily.
const LazyHeading = dynamic(() => import("../components/lazy-heading"));

export const getServerSideProps = () => ({ props: {} });

export default function Page() {
  return <LazyHeading />;
}
