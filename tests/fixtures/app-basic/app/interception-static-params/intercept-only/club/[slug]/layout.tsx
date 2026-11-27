import type { ReactNode } from "react";
import { ClubLayout, type ClubParams } from "../../../_components/club";

export default async function Layout({
  children,
  modal,
  params,
}: {
  children: ReactNode;
  modal: ReactNode;
  params: ClubParams;
}) {
  const { slug } = await params;
  return (
    <ClubLayout base="intercept-only" modal={modal} slug={slug}>
      {children}
    </ClubLayout>
  );
}
