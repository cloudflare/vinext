export default function ThrowingLayout(): never {
  throw new Error("Nested layout error");
}
