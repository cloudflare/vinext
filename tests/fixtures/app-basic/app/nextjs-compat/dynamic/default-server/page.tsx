// Server component variant of ../default/page.tsx: dynamic() without a
// loading option, rendered in the RSC environment.
import dynamic from "next/dynamic";

const DynamicHeader = dynamic(() => {
  return new Promise<typeof import("../default/dynamic-component")>((resolve) => {
    setTimeout(() => {
      resolve(import("../default/dynamic-component"));
    }, 200);
  });
});

const Page = () => {
  return (
    <div>
      <DynamicHeader />
    </div>
  );
};

export default Page;
