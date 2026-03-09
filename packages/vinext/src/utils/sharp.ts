let _sharpModule: typeof import("sharp") | null | undefined;

export async function tryRequireSharp(): Promise<typeof import("sharp") | null> {
  if (_sharpModule !== undefined) return _sharpModule;
  try {
    const mod = await import("sharp");
    _sharpModule = mod.default ?? mod;
    return _sharpModule;
  } catch {
    _sharpModule = null;
    return null;
  }
}
