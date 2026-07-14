export function GET() {
  const state = globalThis as typeof globalThis & {
    __vinextUnselectedActionModuleLoads?: number;
  };
  return Response.json({ unselected: state.__vinextUnselectedActionModuleLoads ?? 0 });
}
