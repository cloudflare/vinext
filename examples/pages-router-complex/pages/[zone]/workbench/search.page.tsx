import Form from "next/form";
import { usePathname, useSearchParams } from "next/navigation";

import { DeskLayout } from "@atlas/workbench/desk-layout";
import { workbenchServerProps } from "@atlas/workbench/page-data";

/** Pulls in the next/navigation hooks and next/form, which only pages load. */
const SearchDesk = () => {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const term = searchParams?.get("q") ?? "";
  return (
    <DeskLayout desk="search" title="Search">
      <Form action={pathname ?? "/workbench/search"} data-testid="search-form">
        <input name="q" defaultValue={term} data-testid="search-input" />
        <button type="submit">Search</button>
      </Form>
      <p data-testid="search-term">{term || "(none)"}</p>
    </DeskLayout>
  );
};

export const getServerSideProps = workbenchServerProps("search");

export default SearchDesk;
