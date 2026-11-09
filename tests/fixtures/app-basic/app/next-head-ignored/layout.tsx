import type { ReactNode } from "react";
import { NextHeadSharedLayout } from "../../components/next-head-shared-layout";

export const metadata = {
  title: "next-head-ignored metadata title",
  description: "next-head-ignored metadata description",
};

export default function NextHeadIgnoredLayout({ children }: { children: ReactNode }) {
  return <NextHeadSharedLayout>{children}</NextHeadSharedLayout>;
}
