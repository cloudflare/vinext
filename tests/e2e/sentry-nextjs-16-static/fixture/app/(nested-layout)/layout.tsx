import { PropsWithChildren } from 'react';

export const dynamic = 'force-dynamic';

export default function Layout({ children }: PropsWithChildren<{}>) {
  return (
    <div>
      <p>Layout</p>
      {children}
    </div>
  );
}
