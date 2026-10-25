export default function FeedLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div id="not-found-intercept-reset-feed">
      {children}
      {modal}
    </div>
  );
}
