export default function SitePage({ params }: { params: { subdomain: string } }) {
  return <div>Site: {params.subdomain}</div>;
}
