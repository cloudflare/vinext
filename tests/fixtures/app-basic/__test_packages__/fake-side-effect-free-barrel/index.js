// A sideEffects:false barrel whose unused leaf calls React.createContext() at
// module scope, which the RSC environment's React does not provide. Vite dev
// does not tree-shake, so it must follow the re-export of BarrelLabel instead
// of evaluating this whole barrel in the RSC environment.
export { BarrelLabel } from "./label.js";
export { BarrelWidget, BarrelWidgetContext } from "./widget.js";
