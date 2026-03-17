import ShowParams from "../../../show-params";

export default async function Lvl3Layout(props: {
  children: React.ReactNode;
  params: Promise<Record<string, unknown>>;
}) {
  const params = await props.params;
  return (
    <div>
      <ShowParams prefix="lvl3" params={params} />
      {props.children}
    </div>
  );
}
