/**
 * Simplified codehike shim for vinext playground.
 *
 * The original imports codehike/blocks, codehike/code, zod, and mdx/types
 * which are heavy deps not needed for the basic playground demo.
 * This provides the same exports with simple placeholder implementations.
 */
import { Prose } from '#/ui/prose';
import Image from 'next/image';
import { JSX } from 'react';

export function Grid(props: { children?: React.ReactNode }) {
  return (
    <div className="my-5 grid grid-cols-1 gap-6 lg:grid-cols-2 [&:first-child]:mt-0 [&:last-child]:mb-0">
      {props.children}
    </div>
  );
}

export function Mdx({
  source: MdxComponent,
  components = {},
  collapsed,
  className,
  ...props
}: {
  source: (props: any) => JSX.Element;
  components?: Record<string, React.ComponentType<any>>;
  collapsed?: boolean;
  className?: string;
}) {
  return (
    <Prose
      collapsed={collapsed}
      className="prose prose-sm prose-invert prose-h1:font-medium prose-h2:font-medium prose-h3:font-medium prose-h4:font-medium prose-h5:font-medium prose-h6:font-medium prose-pre:mt-0 prose-pre:mb-0 prose-pre:rounded-none prose-pre:bg-transparent max-w-none"
    >
      <MdxComponent
        components={{ Image, ...components }}
        {...props}
      />
    </Prose>
  );
}
