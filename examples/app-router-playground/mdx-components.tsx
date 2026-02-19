import type { MDXComponents } from 'mdx/types';
import Link from 'next/link';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...components,
    a: (props: any) => {
      if (!props.href) throw new Error('href is required');
      return <Link {...props} />;
    },
  };
}
