import { BreadcrumbState } from "../../breadcrumb-state";

export default async function ClientCacheBreadcrumb({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <span>
      Catchall {JSON.stringify({ id })}
      <BreadcrumbState />
    </span>
  );
}
