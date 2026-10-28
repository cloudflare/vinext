import { createContext, createElement } from "react";

export const BarrelWidgetContext = createContext(null);

export function BarrelWidget() {
  return createElement(BarrelWidgetContext.Provider, { value: null }, "widget");
}
