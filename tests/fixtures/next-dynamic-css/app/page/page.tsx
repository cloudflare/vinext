import { cookies } from "next/headers";
import "fixture-global-css";
import Global2Owner from "./global2-owner";
import Inner2 from "./inner2";

export default async function Page() {
  await cookies();
  return (
    <>
      <Global2Owner />
      <p id="global">Hello Global</p>
      <Inner2 />
    </>
  );
}
