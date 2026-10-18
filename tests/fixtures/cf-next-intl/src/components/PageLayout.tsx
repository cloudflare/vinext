import {ReactNode} from 'react';

type Props = {
  children?: ReactNode;
  title: string;
};

export default function PageLayout({children, title}: Props) {
  return (
    <div style={{maxWidth: 510}}>
      <h1>{title}</h1>
      {children}
    </div>
  );
}
