import Image from "next/image";
import { ClientImage } from "./client-image";

// No `images.qualities` in the fixture config, so Next.js 16 allows only its
// default `[75]` and the default loader rounds `quality={90}` down to it.
export default function ImageDefaultQualitiesPage() {
  return (
    <main>
      <Image
        id="server-quality-90"
        alt="server"
        src="/get-image-props-light.png"
        width={64}
        height={64}
        quality={90}
      />
      <ClientImage />
    </main>
  );
}
