"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { loadWidget } from "./load-widget";

export function PreloadLink(props: ComponentProps<typeof Link>) {
  return <Link {...props} onMouseEnter={() => void loadWidget()} />;
}
