/**
 * Top-level layout for layout-params tests.
 * In the Next.js test, "root-layout" and "lvl1-layout" both have no params.
 * Since we nest under /nextjs-compat/layout-params/, this layout corresponds
 * to both root and lvl1 — it should receive empty params.
 */
import ShowParams from "./show-params";

export default async function LayoutParamsLayout(props: {
  children: React.ReactNode;
  params: Promise<Record<string, unknown>>;
}) {
  const params = await props.params;
  return (
    <div>
      <ShowParams prefix="root" params={params} />
      <ShowParams prefix="lvl1" params={params} />
      {props.children}
    </div>
  );
}
