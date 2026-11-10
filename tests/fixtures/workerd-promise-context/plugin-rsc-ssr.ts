// Stands in for @vitejs/plugin-rsc/ssr, whose virtual modules only exist in a
// Vite build. The client-reference wrapper only registers a callback with it.
export function setOnClientReference(): void {}
