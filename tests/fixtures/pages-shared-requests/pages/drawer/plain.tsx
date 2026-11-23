import dynamic from "next/dynamic";

const Drawer = dynamic(() => import("../../lib/drawer/drawer"));

export default function DrawerPlain() {
  return (
    <main data-page="drawer/plain">
      <Drawer />
    </main>
  );
}
