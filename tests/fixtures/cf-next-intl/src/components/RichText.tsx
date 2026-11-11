import {ComponentProps, ReactNode} from 'react';

type Tag = 'b' | 'i';

type Props = {
  children(tags: Record<Tag, (chunks: ReactNode) => ReactNode>): ReactNode;
} & Omit<ComponentProps<'p'>, 'children'>;

export default function RichText({children, ...rest}: Props) {
  return (
    <p {...rest}>
      {children({
        b: (chunks: ReactNode) => <b style={{fontWeight: 'bold'}}>{chunks}</b>,
        i: (chunks: ReactNode) => <i style={{fontStyle: 'italic'}}>{chunks}</i>
      })}
    </p>
  );
}
