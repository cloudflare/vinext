export default function WithPageProps({ fromApp }: { fromApp: string }) {
  return <div id="page-content">{fromApp}</div>;
}
