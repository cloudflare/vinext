import Component from "../../../component";

export default function Page(props: { params: Promise<Record<string, string | string[]>> }) {
  return (
    <Component
      file="/parallel-route-navigations/[teamID]/@slot/[...catchAll]/page.tsx"
      params={props.params}
    />
  );
}
