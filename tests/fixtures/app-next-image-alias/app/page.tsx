// The test config aliases next/image to ./image-wrapper.tsx.
import Image from "next/image";

export default function Page() {
  return <Image src="/x.png" width={10} height={10} alt="" />;
}
