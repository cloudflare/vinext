export default async function AutoscrollPositionPage({
  params,
}: {
  params: Promise<{ param: string }>;
}) {
  const { param } = await params;

  return (
    <div
      id="page"
      style={{
        background: "#63d471",
        flexGrow: 1,
      }}
    >
      {param}
    </div>
  );
}
