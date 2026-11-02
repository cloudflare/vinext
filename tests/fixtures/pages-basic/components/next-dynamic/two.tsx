import something from "./apples";

export default function Two() {
  // Use the shared module so it is not tree shaken.
  console.log(something);
  return "2";
}
