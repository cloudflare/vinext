declare module "lib-cjs" {
  const Library: () => string;
  export default Library;
}

declare module "lib-esm" {
  const Library: () => string;
  export default Library;
}
