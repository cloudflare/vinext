import Image from "next/image";

export default function ImageFillSizesWarningPage() {
  return (
    <main>
      <h1>Image Fill Sizes Warning</h1>
      <div style={{ position: "relative", width: 300, height: 100 }}>
        <Image id="fill-missing-sizes" src="/get-image-props-dark.png" alt="" fill />
      </div>
      <div style={{ position: "relative", width: 300, height: 100 }}>
        <Image id="fill-sizes-100vw" src="/get-image-props-light.png" alt="" fill sizes="100vw" />
      </div>
      <div style={{ position: "relative", width: 300, height: 100 }}>
        <Image
          id="fill-explicit-sizes"
          src="/image-fill-sizes-explicit.png"
          alt=""
          fill
          sizes="300px"
        />
      </div>
      <div style={{ position: "relative", width: 300, height: 100 }}>
        <Image
          id="fill-unoptimized"
          src="/image-fill-sizes-unoptimized.png"
          alt=""
          fill
          unoptimized
        />
      </div>
      <div style={{ position: "relative", width: "100%", height: 100 }}>
        <Image id="fill-full-width" src="/image-fill-sizes-full-width.png" alt="" fill />
      </div>
    </main>
  );
}
