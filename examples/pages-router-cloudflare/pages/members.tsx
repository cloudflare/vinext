import type { GetServerSidePropsResult } from "next";

interface MembersProps {
  record: string;
}

// Guarded only by the exact `/members` middleware matcher.
export async function getServerSideProps(): Promise<GetServerSidePropsResult<MembersProps>> {
  return { props: { record: "synthetic-members-record" } };
}

export default function MembersPage({ record }: MembersProps) {
  return <p data-testid="members-record">{record}</p>;
}
