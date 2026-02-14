import db from '#/lib/db';
import { Boundary } from '#/ui/boundary';
import { Mdx } from '#/ui/codehike';
import React from 'react';
import readme from './readme.mdx';

export function generateMetadata() {
  const demo = db.demo.find({ where: { slug: 'cached-components' } });

  return {
    title: demo.name,
    openGraph: { title: demo.name, images: [`/api/og?title=${demo.name}`] },
  };
}

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Boundary label="Demo" kind="solid" animateRerendering={false}>
        <Mdx source={readme} collapsed={true} />
      </Boundary>

      <Boundary
        label="layout.tsx (statically inferred)"
        kind="solid"
        animateRerendering={false}
      >
        {children}
      </Boundary>
    </>
  );
}
