import React from "react";

// This page simulates a missing resource by returning notFound from getServerSideProps
export default function MissingPost() {
  return <div>This should never render</div>;
}

export async function getServerSideProps() {
  return {
    notFound: true,
  };
}
