import clsx from 'clsx';
import React from 'react';

type Color = 'gray' | 'pink' | 'blue' | 'violet' | 'cyan' | 'orange' | 'red';
type Border = 'dashed' | 'solid';
type Size = 'small' | 'medium';

export const Boundary = ({
  children,
  label,
  size = 'medium',
  color = 'gray',
  kind = 'dashed',
  animateRerendering = true,
  corners,
  className,
  pulse = false,
}: {
  children: React.ReactNode;
  label?: string | string[];
  size?: Size;
  color?: Color;
  kind?: Border;
  animateRerendering?: boolean;
  corners?: boolean;
  className?: string;
  pulse?: boolean;
}) => {
  return (
    <div
      className={clsx('relative border', {
        'border-dashed': kind === 'dashed',
        'border-gray-800': color === 'gray',
        'border-pink-800': color === 'pink',
        'border-blue-800': color === 'blue',
        'border-cyan-800': color === 'cyan',
        'border-violet-800': color === 'violet',
        'border-orange-900': color === 'orange',
        'border-red-900': color === 'red',
        'animate-[rerender_1s_ease-in-out_1] text-blue-600': animateRerendering,
        'animate-pulse': pulse,
      })}
    >
      {corners && (
        <>
          <svg
            viewBox="0 0 24 24"
            className="absolute top-0 left-0 z-10 size-[24px] -translate-x-[calc(50%+0.5px)] -translate-y-[calc(50%+0.5px)]"
          >
            <path stroke="currentColor" d="M12 6L12 18M6 12L18 12" />
          </svg>
          <svg
            viewBox="0 0 24 24"
            className="absolute right-0 bottom-0 z-10 size-[24px] translate-x-[calc(50%+0.5px)] translate-y-[calc(50%+0.5px)]"
          >
            <path stroke="currentColor" d="M12 6L12 18M6 12L18 12" />
          </svg>
        </>
      )}

      {label ? (
        <div
          className={clsx('absolute flex -translate-y-1/2 gap-x-1 text-[9px]', {
            'left-3 lg:left-5': size === 'small',
            'left-4 lg:left-9': size === 'medium',
          })}
        >
          {[...(typeof label === 'string' ? [label] : label)].map((label) => (
            <Label
              key={label}
              color={color}
              animateRerendering={animateRerendering}
            >
              {label}
            </Label>
          ))}
        </div>
      ) : null}

      <div
        className={clsx(className, {
          'p-3 lg:p-5': size === 'small',
          'p-4 lg:p-9': size === 'medium',
        })}
      >
        {children}
      </div>
    </div>
  );
};

const Label = ({
  children,
  animateRerendering,
  color,
}: {
  children: React.ReactNode;
  animateRerendering?: boolean;
  color?: Color;
}) => {
  return (
    <div
      className={clsx(
        'px-1.5 font-mono leading-4 font-medium tracking-widest uppercase ring-6 ring-gray-950',
        {
          'bg-gray-800 text-gray-500': color === 'gray',
          'bg-pink-600 text-pink-200': color === 'pink',
          'bg-blue-600 text-blue-200': color === 'blue',
          'bg-cyan-500 text-cyan-100': color === 'cyan',
          'bg-violet-700 text-violet-200': color === 'violet',
          'bg-orange-500 text-orange-200': color === 'orange',
          'bg-red-800 text-red-300': color === 'red',
          'animate-[highlight_1s_ease-in-out_1]': animateRerendering,
        },
      )}
    >
      {children}
    </div>
  );
};
