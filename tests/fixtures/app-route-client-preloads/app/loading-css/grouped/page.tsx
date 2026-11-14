import { GroupedNote } from "./grouped-note";

export const dynamic = "force-dynamic";

// The page imports the note but renders it only with `?note`. Its not-found
// boundary renders another client component with CSS, which this route alone
// reaches, as it does the note. Both style the paragraph below with rules of
// the same specificity, and the note's must win.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { note } = await searchParams;
  return (
    <main>
      <p className="loading-css-grouped" data-testid="loading-css-grouped">
        grouped
      </p>
      {note !== undefined && <GroupedNote />}
    </main>
  );
}
