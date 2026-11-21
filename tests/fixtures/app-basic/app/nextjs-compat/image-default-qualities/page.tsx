import Image from "next/image";
import { ClientImage } from "./client-image";

// No `images.qualities` in the fixture config. vinext deliberately keeps the
// Next.js 14/15 behaviour here (the prop is used as written) instead of
// Next.js 16's `[75]` default, which would round `quality={90}` to 75.
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
      <Image
        id="server-no-quality"
        alt="server default"
        src="/get-image-props-light.png"
        width={64}
        height={64}
      />
      <ClientImage />
    </main>
  );
}
