import type { ReactNode } from "react";

type TeamParams = Promise<{ team: string; slug: string }>;

export function TeamLayout({
  breadcrumbs,
  children,
}: {
  breadcrumbs: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div data-testid="parallel-slot-breadcrumbs">{breadcrumbs}</div>
      {children}
    </>
  );
}

export async function TeamStory({ params }: { params: TeamParams }) {
  const { team, slug } = await params;
  return (
    <p data-testid="parallel-slot-story">
      Story: {team}/{slug}
    </p>
  );
}

export async function TeamBreadcrumb({ params }: { params: TeamParams }) {
  const { team, slug } = await params;
  return (
    <p data-testid="parallel-slot-breadcrumb">
      Breadcrumb: {team}/{slug}
    </p>
  );
}

export function DefaultBreadcrumbs() {
  return <p>Default breadcrumbs</p>;
}
