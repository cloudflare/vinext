import addWasm from "./add.wasm?module";

export async function GET() {
  const instance = await WebAssembly.instantiate(addWasm);
  const addOne = instance.exports.add_one as (value: number) => number;

  return Response.json({ result: addOne(41) });
}
