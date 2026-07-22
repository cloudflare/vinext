declare module "*.wasm?module" {
  const module: WebAssembly.Module;
  export default module;
}
