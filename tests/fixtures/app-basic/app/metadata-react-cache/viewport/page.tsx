import type { Viewport } from "next";
import { getThemeColor } from "../data";

export function generateViewport(): Viewport {
  return { themeColor: getThemeColor() };
}

export default function Page() {
  return <p id="theme-color">{getThemeColor()}</p>;
}
