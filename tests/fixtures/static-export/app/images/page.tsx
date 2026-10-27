import Image from "next/image";
import LegacyImage from "next/legacy/image";
import { LoaderPropImage } from "./loader-prop-image";

export default function ImagesPage() {
  return (
    <main>
      <h1>Images</h1>
      <Image alt="loader-file" src="/logo.png" width={64} height={64} priority />
      <Image
        alt="loader-file-override"
        src="/logo.png"
        width={64}
        height={64}
        overrideSrc="/override.png"
        priority
      />
      <div style={{ position: "relative", width: 64, height: 64 }}>
        <Image alt="loader-file-fill" src="/logo.png" fill priority />
      </div>
      <LoaderPropImage />
      <LegacyImage alt="legacy" src="/logo.png" width={64} height={64} priority />
    </main>
  );
}
