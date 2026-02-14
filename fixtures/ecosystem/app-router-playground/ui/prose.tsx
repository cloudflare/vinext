'use client';

import clsx from 'clsx';
import React from 'react';

export function Prose({
  children,
  className,
  collapsed,
}: {
  children: React.ReactNode;
  className?: string;
  collapsed?: boolean;
}) {
  const isCollapsible = typeof collapsed === 'boolean';
  const [isCollapsed, setIsCollapsed] = React.useState(collapsed);
  const contentId = React.useId();

  return (
    <div className={clsx(className)}>
      <div
        id={contentId}
        role={isCollapsible ? 'region' : undefined}
        aria-hidden={isCollapsible && isCollapsed}
        aria-expanded={isCollapsible && !isCollapsed}
        className={clsx({
          'max-h-[5lh] overflow-hidden': isCollapsible && isCollapsed,
          '[mask-image:linear-gradient(to_bottom,black_60%,transparent_100%)]':
            isCollapsed,
        })}
      >
        {children}
      </div>

      {isCollapsible && (
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          aria-controls={contentId}
          aria-expanded={!isCollapsed}
          className="mt-4 rounded-sm bg-gray-800 px-1.5 py-1 text-xs leading-none font-semibold whitespace-nowrap text-gray-300 tabular-nums hover:bg-gray-500 hover:text-white"
        >
          {isCollapsed ? 'More' : 'Less'}
        </button>
      )}
    </div>
  );
}
