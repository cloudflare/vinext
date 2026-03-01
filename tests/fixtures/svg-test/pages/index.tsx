import Image from "next/image";
import Head from "next/head";

export default function SvgTestPage() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 800, margin: "0 auto" }}>
      <Head>
        <title>SVG Image Test — vinext</title>
      </Head>

      <h1>SVG Image Optimization Test</h1>
      <p style={{ color: "#666" }}>
        This page tests whether SVG images can be served through the{" "}
        <code style={{ background: "#f0f0f0", padding: "2px 6px", borderRadius: 4 }}>/_vinext/image</code> endpoint.
      </p>

      <hr style={{ margin: "2rem 0" }} />

      <h2>1. SVG via next/image (through /_vinext/image)</h2>
      <p>
        If <code>dangerouslyAllowSVG</code> is <b>not</b> set → <b style={{ color: "red" }}>broken image</b> (400 error).<br />
        If <code>dangerouslyAllowSVG: true</code> → <b style={{ color: "green" }}>renders correctly</b>.
      </p>
      <div style={{ border: "2px dashed #ccc", padding: "1rem", borderRadius: 8, display: "inline-block", background: "#fafafa" }}>
        <Image
          src="/logo.svg"
          alt="vinext logo (SVG via next/image)"
          width={256}
          height={256}
        />
      </div>

      <hr style={{ margin: "2rem 0" }} />

      <h2>2. SVG via plain &lt;img&gt; (direct, no optimization)</h2>
      <p>This always works — it bypasses the image optimization endpoint entirely.</p>
      <div style={{ border: "2px dashed #ccc", padding: "1rem", borderRadius: 8, display: "inline-block", background: "#fafafa" }}>
        <img src="/logo.svg" alt="vinext logo (direct img)" width={256} height={256} />
      </div>

      <hr style={{ margin: "2rem 0" }} />

      <h2>3. JPEG via next/image (always works)</h2>
      <p>JPEG is always allowed, regardless of SVG config.</p>
      <div style={{ border: "2px dashed #ccc", padding: "1rem", borderRadius: 8, display: "inline-block", background: "#fafafa" }}>
        <Image
          src="/photo.jpg"
          alt="photo (JPEG via next/image)"
          width={128}
          height={128}
        />
      </div>

      <hr style={{ margin: "2rem 0" }} />
      <h2>How to check</h2>
      <ol>
        <li>Open <b>DevTools → Network</b> tab</li>
        <li>Look for the request to <code>/_vinext/image?url=%2Flogo.svg...</code></li>
        <li>Check its HTTP status code (200 = allowed, 400 = blocked)</li>
      </ol>
    </div>
  );
}
