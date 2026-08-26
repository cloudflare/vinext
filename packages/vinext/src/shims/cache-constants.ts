// Matches Next.js's sentinel for an entry that never revalidates. Keep this in
// a dependency-free module so cache adapters do not pull in the public
// next/cache runtime and its request-scoped machinery.
export const INFINITE_CACHE = 0xfffffffe;
