"use client";

import { useState } from "react";
import Image, { type ImageProps } from "next/image";

// Ported from Next.js: test/e2e/next-image-new/app-dir/app/on-error/page.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/app-dir/app/on-error/page.js
export default function ImageOnErrorPage() {
  const [clicked, setClicked] = useState(false);

  return (
    <div>
      <h1>Test onError</h1>
      <p>If error occurred while loading image, native onError should be called.</p>
      <button id="toggle" onClick={() => setClicked(!clicked)}>
        Toggle
      </button>

      <ImageWithMessage
        id="1"
        alt="img1"
        src="/get-image-props-light.png"
        width={200}
        height={200}
      />
      <ImageWithMessage
        id="2"
        alt="img2"
        src={clicked ? "/404.jpg" : "/get-image-props-dark.png"}
        width="200"
        height="200"
      />
      <div id="footer" />
    </div>
  );
}

function ImageWithMessage({ id, ...props }: { id: string } & ImageProps) {
  const [msg, setMsg] = useState(`no error occurred for img${id}`);

  return (
    <>
      <div className="wrap">
        <Image
          id={`img${id}`}
          onError={(e) => {
            setMsg(`error occurred while loading ${e.currentTarget.id}`);
          }}
          {...props}
        />
      </div>
      <p id={`msg${id}`}>{msg}</p>
      <hr />
    </>
  );
}
