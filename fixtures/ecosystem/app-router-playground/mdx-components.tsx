import Link from 'next/link';

export function useMDXComponents(components: Record<string, any>): Record<string, any> {
  return {
    ...components,
    a: (props: any) => {
      if (!props.href) throw new Error('href is required');
      return <Link {...props} />;
    },
  };
}
