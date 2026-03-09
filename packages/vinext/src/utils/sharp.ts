// sharp is an optional peer dependency — avoid static type imports
let _sharpModule: any;

export async function tryRequireSharp(): Promise<((input: Buffer | Uint8Array) => any) | null> {
  if (_sharpModule !== undefined) return _sharpModule;
  try {
    // @ts-ignore — sharp may not be installed (optional peer dep)
    const mod = await import("sharp");
    _sharpModule = mod.default ?? mod;
    return _sharpModule;
  } catch {
    _sharpModule = null;
    return null;
  }
}
