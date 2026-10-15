import type { ReactNode } from "react";
import { recordLayoutCall } from "../static-params-calls";

export const dynamicParams = false;

export function generateStaticParams() {
  recordLayoutCall();
  return [{ category: "docs" }, { category: "guides" }, { category: "reference" }];
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
