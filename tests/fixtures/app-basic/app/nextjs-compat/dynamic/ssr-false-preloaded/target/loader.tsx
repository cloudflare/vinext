"use client";

import dynamic from "next/dynamic";
import { loadWidget } from "../load-widget";

const Widget = dynamic(() => loadWidget(), { ssr: false });

export function Loader() {
  return <Widget />;
}
