require("server-only");

export default function Page() {
  return <div data-testid="cjs-server-only">This page uses CJS require server only</div>;
}
