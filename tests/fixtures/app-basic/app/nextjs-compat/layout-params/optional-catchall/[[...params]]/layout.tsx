import ShowParams from "../../show-params";

export default async function OptionalCatchallLayout(props: {
  children: React.ReactNode;
  params: Promise<Record<string, unknown>>;
}) {
  const params = await props.params;
  return (
    <div>
      <ShowParams prefix="lvl2" params={params} />
      {props.children}
    </div>
  );
}
