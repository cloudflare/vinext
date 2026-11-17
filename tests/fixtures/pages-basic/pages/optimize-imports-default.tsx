import { DefaultUsed } from "@tremor/react";

export default function OptimizeImportsDefaultPage() {
  return (
    <main>
      <DefaultUsed id="pages-default-barrel" />
    </main>
  );
}

// Render on the server for every request, so the check reads the server runtime.
export function getServerSideProps() {
  return { props: {} };
}
