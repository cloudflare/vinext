import { cookies } from "next/headers";
import "./global2.css";
import Inner2 from "./inner2";

export default async function NextDynamicCssPage() {
  await cookies();
  return (
    <>
      <p id="global">Hello Global</p>
      <Inner2 />
    </>
  );
}
