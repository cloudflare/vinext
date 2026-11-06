import something from "./apples";

export default function One() {
  // Use the shared module so it is not tree shaken.
  console.log(something);
  return "1";
}
