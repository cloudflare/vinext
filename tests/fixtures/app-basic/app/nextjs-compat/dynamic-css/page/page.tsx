import "./global2.css";
import Inner2 from "./inner2";
import { cookies } from "next/headers";

export default async function DynamicCssPage() {
  await cookies();

  return (
    <>
      <p id="dynamic-css-global">Hello Global</p>
      <Inner2 />
    </>
  );
}
