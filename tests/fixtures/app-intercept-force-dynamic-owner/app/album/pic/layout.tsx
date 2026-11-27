// Below the intercept's owner folder, but /album/pic/[id] still renders it
// around the intercept.
export const dynamic = "force-dynamic";

export default function AlbumPicLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
