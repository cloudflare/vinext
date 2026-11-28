import Image, { getImageProps } from "next/image";

export default function Page() {
  const { props } = getImageProps({
    id: "props-loader-file",
    alt: "props-loader-file",
    src: "/logo.png",
    width: 400,
    height: 400,
  });
  return (
    <main>
      <Image id="loader-file" alt="loader-file" src="/logo.png" width={400} height={400} priority />
      <img {...props} />
    </main>
  );
}
