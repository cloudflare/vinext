import { Boundary } from '#/ui/boundary';
import { Mdx } from '#/ui/codehike';
import { CounterProvider } from 'app/context/counter-context';
import React from 'react';
import ContextClickCounter from './context-click-counter';
import Readme from './readme.mdx';
const title = 'Client Context';

export const metadata = {
  title,
  openGraph: { title, images: [`/api/og?title=${title}`] },
};

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Boundary label="Demo" kind="solid" animateRerendering={false}>
        <Mdx source={Readme} collapsed={true} />
      </Boundary>

      <Boundary
        label="layout.tsx (Server Environment)"
        kind="solid"
        animateRerendering={false}
      >
        <Boundary
          label="Context Provider (Client Environment)"
          color="blue"
          animateRerendering={false}
        >
          <CounterProvider>
            <div className="flex flex-col gap-9">
              <ContextClickCounter />
              {children}
            </div>
          </CounterProvider>
        </Boundary>
      </Boundary>
    </>
  );
}
