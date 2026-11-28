import Image, { getImageProps } from "next/image";
import LegacyImage from "next/legacy/image";

function loader({ src, width, quality }: { src: string; width: number; quality?: number }) {
  return `${src}?wid=${width}&qual=${quality || 35}`;
}

export default function Page() {
  const { props: fromLoaderFile } = getImageProps({
    id: "props-loader-file",
    alt: "props-loader-file",
    src: "/logo.png",
    width: 400,
    height: 400,
  });
  const { props: fromLoaderProp } = getImageProps({
    id: "props-loader-prop",
    alt: "props-loader-prop",
    src: "/logo.png",
    width: 200,
    height: 200,
    loader,
  });
  return (
    <main>
      <Image id="loader-file" alt="loader-file" src="/logo.png" width={400} height={400} priority />
      <Image
        id="loader-prop"
        alt="loader-prop"
        src="/logo.png"
        width={200}
        height={200}
        loader={loader}
      />
      <img {...fromLoaderFile} />
      <img {...fromLoaderProp} />
      <LegacyImage id="legacy" alt="legacy" src="/logo.png" width={400} height={400} />
    </main>
  );
}
