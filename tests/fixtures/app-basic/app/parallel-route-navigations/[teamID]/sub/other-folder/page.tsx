import Component from "../../../component";

export default function Page(props: { params: Promise<Record<string, string | string[]>> }) {
  return (
    <Component
      file="/parallel-route-navigations/[teamID]/sub/other-folder/page.tsx"
      params={props.params}
    />
  );
}
