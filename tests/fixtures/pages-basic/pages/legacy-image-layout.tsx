import Image from "next/legacy/image";

const src =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='320'%3E%3C/svg%3E";

export default function LegacyImageLayout() {
  return (
    <main>
      <div id="image-container" style={{ width: 800 }}>
        <Image id="default-image" src={src} alt="Default layout" width={640} height={320} />
        <Image
          id="intrinsic-image"
          src={src}
          alt="Intrinsic layout"
          width={640}
          height={320}
          layout="intrinsic"
        />
        <Image
          id="fixed-image"
          src={src}
          alt="Fixed layout"
          width={640}
          height={320}
          layout="fixed"
        />
        <Image
          id="responsive-image"
          src={src}
          alt="Responsive layout"
          width={640}
          height={320}
          layout="responsive"
        />
      </div>
    </main>
  );
}
