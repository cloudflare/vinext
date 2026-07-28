"use client";

import {
  createContext,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type DialogHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  type TableHTMLAttributes,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function TableRoot({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cx("w-full border-collapse text-left text-sm", className)} {...props} />;
}

function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cx("border-b border-[var(--line)]", className)} {...props} />;
}

function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

function TableRow({
  className,
  hoverable = true,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { hoverable?: boolean }) {
  return (
    <tr
      className={cx(
        "border-b border-[var(--line-soft)] transition-colors last:border-b-0",
        hoverable && "hover:bg-[var(--surface-2)]",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: ComponentPropsWithoutRef<"th">) {
  return (
    <th
      className={cx(
        "px-4 py-3 font-mono text-[11px] font-medium tracking-[0.08em] whitespace-nowrap text-[var(--mute)] uppercase",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: ComponentPropsWithoutRef<"td">) {
  return <td className={cx("px-4 py-3 text-[var(--ink-sub)]", className)} {...props} />;
}

export const Table = Object.assign(TableRoot, {
  Header: TableHeader,
  Body: TableBody,
  Row: TableRow,
  Head: TableHead,
  Cell: TableCell,
});

type Tab<Value extends string> = { value: Value; label: ReactNode };

export function Tabs<const Value extends string>({
  tabs,
  value,
  onValueChange,
  className,
}: {
  tabs: ReadonlyArray<Tab<Value>>;
  value: Value;
  onValueChange: (value: Value) => void;
  variant?: "segmented";
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex max-w-full gap-1 overflow-x-auto border-b border-[var(--line)]",
        className,
      )}
      role="tablist"
    >
      {tabs.map((tab, index) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={cx(
              // Underline lives on every tab (scaled to zero when unselected) so
              // selection grows it in instead of popping a new pseudo-element.
              "relative shrink-0 px-3 py-2.5 font-mono text-xs text-[var(--mute)] transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:origin-center after:scale-x-0 after:bg-[var(--orange)] after:transition-transform after:duration-200 after:ease-[var(--ease-out)] hover:text-[var(--ink)] motion-reduce:after:transition-none",
              selected && "text-[var(--ink)] after:scale-x-100",
            )}
            onClick={() => onValueChange(tab.value)}
            onKeyDown={(event) => {
              let nextIndex: number | null = null;
              if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
              if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
              if (event.key === "Home") nextIndex = 0;
              if (event.key === "End") nextIndex = tabs.length - 1;
              if (nextIndex === null) return;
              event.preventDefault();
              const buttons =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                );
              buttons?.[nextIndex]?.focus();
              onValueChange(tabs[nextIndex].value);
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

type DialogContextValue = {
  open: boolean;
  titleId: string;
  descriptionId: string;
  setOpen: (open: boolean) => void;
};

const DialogContext = createContext<DialogContextValue | null>(null);

function useDialog() {
  const context = useContext(DialogContext);
  if (!context) throw new Error("Dialog components must be rendered inside Dialog.Root");
  return context;
}

function DialogRoot({
  children,
  onOpenChange,
}: {
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const setOpen = (nextOpen: boolean) => {
    if (open === nextOpen) return;
    setOpenState(nextOpen);
    onOpenChange?.(nextOpen);
  };

  return (
    <DialogContext value={{ open, titleId, descriptionId, setOpen }}>{children}</DialogContext>
  );
}

function DialogTrigger(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { setOpen } = useDialog();
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) setOpen(true);
      }}
    />
  );
}

function DialogSurface(props: DialogHTMLAttributes<HTMLDialogElement>) {
  const { descriptionId, open, setOpen, titleId } = useDialog();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      {...props}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={cx(
        "token-dialog m-auto rounded-2xl border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] shadow-2xl",
        props.className,
      )}
      onCancel={(event) => {
        event.preventDefault();
        setOpen(false);
      }}
      onClose={() => setOpen(false)}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented && event.target === event.currentTarget) setOpen(false);
      }}
    >
      {props.children}
    </dialog>
  );
}

function DialogTitle({ className, ...props }: ComponentPropsWithoutRef<"h2">) {
  const { titleId } = useDialog();
  return <h2 id={titleId} className={className} {...props} />;
}

function DialogDescription({ className, ...props }: ComponentPropsWithoutRef<"p">) {
  const { descriptionId } = useDialog();
  return <p id={descriptionId} className={className} {...props} />;
}

function DialogClose(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { setOpen } = useDialog();
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) setOpen(false);
      }}
    />
  );
}

export const Dialog = Object.assign(DialogSurface, {
  Root: DialogRoot,
  Trigger: DialogTrigger,
  Title: DialogTitle,
  Description: DialogDescription,
  Close: DialogClose,
});

export type BadgeVariant =
  | "primary"
  | "secondary"
  | "green"
  | "destructive"
  | "ok"
  | "partial"
  | "neutral"
  | "accent";

const badgeVariants: Record<BadgeVariant, string> = {
  primary: "border-[var(--orange)] bg-[var(--orange)] text-[var(--on-accent)]",
  secondary: "border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink-sub)]",
  green: "border-[color:var(--ok)]/30 bg-[color:var(--ok)]/10 text-[var(--ok)]",
  destructive: "border-red-500/30 bg-red-500/10 text-red-400",
  ok: "border-[color:var(--ok)]/30 bg-[color:var(--ok)]/10 text-[var(--ok)]",
  partial: "border-[color:var(--partial)]/30 bg-[color:var(--partial)]/10 text-[var(--partial)]",
  neutral: "border-[var(--line)] bg-[var(--surface-2)] text-[var(--mute)]",
  accent: "border-[color:var(--orange)]/30 bg-[color:var(--orange)]/10 text-[var(--orange-soft)]",
};

export function Badge({
  variant = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[11px] leading-none font-medium whitespace-nowrap",
        badgeVariants[variant],
        className,
      )}
      {...props}
    />
  );
}
