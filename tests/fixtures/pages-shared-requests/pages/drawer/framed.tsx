import dynamic from "next/dynamic";
import { Frame } from "../../lib/drawer/frame";

const Drawer = dynamic(() => import("../../lib/drawer/drawer"));

export default function DrawerFramed() {
  return (
    <main data-page="drawer/framed">
      <Frame>Framed</Frame>
      <Drawer />
    </main>
  );
}
