import type { ReactNode } from "react";
import { ClubLayout, type ClubParams } from "../../../_components/club";

export default async function Layout({
  children,
  modal,
  params,
  side,
}: {
  children: ReactNode;
  modal: ReactNode;
  params: ClubParams;
  side: ReactNode;
}) {
  const { slug } = await params;
  return (
    <ClubLayout base="owner-default" modal={modal} slug={slug}>
      {children}
      {side}
    </ClubLayout>
  );
}
