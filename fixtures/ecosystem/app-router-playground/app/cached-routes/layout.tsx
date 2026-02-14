'use cache';

import { Boundary } from '#/ui/boundary';
import { Mdx } from '#/ui/codehike';
import React from 'react';
import readme from './readme.mdx';
import { Metadata } from 'next';
import db from '#/lib/db';

export async function generateMetadata(): Promise<Metadata> {
  const demo = db.demo.find({ where: { slug: 'cached-routes' } });

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
        label="layout.tsx (Cacheable)"
        kind="solid"
        animateRerendering={false}
      >
        {children}
      </Boundary>
    </>
  );
}
