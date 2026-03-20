import React from "react";

export default function RedirectXss() {
  return <div>Should not render</div>;
}

export function getStaticProps() {
  return {
    redirect: {
      destination: 'foo" /><script>alert(1)</script><meta x="',
    },
  };
}
