import { Boundary } from '#/ui/boundary';
import { Prose } from '#/ui/prose';
import clsx from 'clsx';
import { Block, parseProps } from 'codehike/blocks';
import {
  Inline,
  InnerLine,
  Pre,
  highlight,
  type AnnotationHandler,
  type RawCode,
} from 'codehike/code';
import { MDXProps } from 'mdx/types';
import Image from 'next/image';
import { type ComponentType, JSX } from 'react';
import { z } from 'zod';

const Schema = Block.extend({ col: z.array(Block) });
const EMPTY_COMPONENTS: Record<string, ComponentType<any>> = {};

function getGridColumnKey(col: { children?: unknown }) {
  const children = Array.isArray(col.children)
    ? col.children
    : col.children === undefined
      ? []
      : [col.children];

  const childKeys = children
    .map((child) => {
      if (typeof child === 'object' && child !== null && 'key' in child) {
        const childKey = (child as { key: string | null }).key;
        return childKey ? String(childKey) : '';
      }

      return '';
    })
    .filter(Boolean);

  return childKeys.join('|') || `column-${children.length}`;
}

export function Grid(props: unknown) {
  const data = parseProps(props, Schema);

  return (
    <div className="my-5 grid grid-cols-1 gap-6 lg:grid-cols-2 [&:first-child]:mt-0 [&:last-child]:mb-0">
      {data.col.map((col) => (
        <div
          className="[&>:first-child]:mt-0 [&>:last-child]:mb-0"
          key={getGridColumnKey(col)}
        >
          {col.children}
        </div>
      ))}
    </div>
  );
}

export const lineNumbers: AnnotationHandler = {
  name: 'line-numbers',
  Line: (props) => {
    const width = props.totalLines.toString().length + 1;
    return (
      <div className="flex">
        <span
          className="text-right opacity-20 select-none"
          style={{ minWidth: `${width}ch` }}
        >
          {props.lineNumber}
        </span>
        <InnerLine merge={props} className="flex-1 pl-2" />
      </div>
    );
  },
};

const mark: AnnotationHandler = {
  name: 'mark',
  Line: ({ annotation, ...props }) => {
    const colors = {
      red: 'border-l-red-600 bg-red-600/10',
      blue: 'border-l-blue-600 bg-blue-600/10',
      green: 'border-l-green-600 bg-green-600/10',
      yellow: 'border-l-yellow-600 bg-yellow-600/10',
      amber: 'border-l-amber-600 bg-amber-600/10',
      purple: 'border-l-purple-600 bg-purple-600/10',
      orange: 'border-l-orange-600 bg-orange-600/10',
      pink: 'border-l-pink-600 bg-pink-600/10',
    };
    const color = (annotation?.query || 'blue') as keyof typeof colors;
    return (
      <div
        className={clsx('border-l-2 border-transparent', {
          [colors[color]]: annotation,
        })}
      >
        <InnerLine merge={props} className="px-[2ch]" />
      </div>
    );
  },
  Inline: ({ annotation, children }) => {
    const color = annotation?.query || 'rgb(14 165 233)';
    return (
      <span
        style={{
          outline: `solid 1px rgb(from ${color} r g b / 0.5)`,
          background: `rgb(from ${color} r g b / 0.13)`,
        }}
      >
        {children}
      </span>
    );
  },
};

async function MyCode({ codeblock }: { codeblock: RawCode }) {
  'use cache';
  const highlighted = await highlight(codeblock, 'github-dark');
  const { background: _background, ...style } = highlighted.style;
  return (
    <Boundary
      label={highlighted.meta}
      kind="solid"
      animateRerendering={false}
      size="small"
      className="not-prose !px-0 !py-0 text-xs"
    >
      <Pre
        className={clsx(
          'overflow-x-auto px-0 py-2 font-mono leading-5',
          { 'pt-3.5': highlighted.meta },
        )}
        code={highlighted}
        handlers={[mark, lineNumbers]}
        style={{ ...style }}
      />
    </Boundary>
  );
}

async function MyInlineCode({ codeblock }: { codeblock: RawCode }) {
  'use cache';
  const highlighted = await highlight(codeblock, 'github-dark');
  return <Inline code={highlighted} style={highlighted.style} />;
}

export function Mdx({
  source: MdxComponent,
  components,
  collapsed,
  className,
  ...props
}: {
  source: (props: MDXProps) => JSX.Element;
  components?: Record<string, ComponentType<any>>;
  collapsed?: boolean;
  className?: string;
}) {
  const resolvedComponents = components ?? EMPTY_COMPONENTS;

  return (
    <Prose
      collapsed={collapsed}
      className={clsx(
        'prose prose-sm prose-invert prose-h1:font-medium prose-h2:font-medium prose-h3:font-medium prose-h4:font-medium prose-h5:font-medium prose-h6:font-medium prose-pre:mt-0 prose-pre:mb-0 prose-pre:rounded-none prose-pre:bg-transparent max-w-none',
        className,
      )}
    >
      <MdxComponent
        components={{ MyCode, MyInlineCode, Image, ...resolvedComponents }}
        {...props}
      />
    </Prose>
  );
}
