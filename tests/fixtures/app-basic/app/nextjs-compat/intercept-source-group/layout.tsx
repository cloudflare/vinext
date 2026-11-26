// A layout above both route groups, with a slot that the whole intercepting
// route opened from `(other)` keeps mounted, so a link in it can intercept
// into that slot from the same source.
export default function InterceptSourceGroupLayout({
  children,
  peek,
}: {
  children: React.ReactNode;
  peek: React.ReactNode;
}) {
  return (
    <>
      {children}
      {peek}
    </>
  );
}
