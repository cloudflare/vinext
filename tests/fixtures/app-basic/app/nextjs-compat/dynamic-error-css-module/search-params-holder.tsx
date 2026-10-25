// A server component that gets searchParams but never reads them. React's dev
// build still serializes its props as debug info, which reads
// `searchParams.then`.
export function SearchParamsHolder(_props: { searchParams: Promise<unknown> }) {
  return null;
}
