// Adapted from Beautiful UI TaskRows (MIT), components/primitives/TaskRows.tsx.
// Its list/capsule and expandable-detail structure uses native T3 row slots here;
// demo timers, fabricated statuses and typography are replaced with live state.
import { type ReactNode, useId } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "../classNames.ts";

export function TaskGroup({
  title,
  open,
  count,
  selected,
  header,
  children,
  onToggle,
}: {
  title: string;
  open: boolean;
  count: number;
  selected: boolean;
  header: ReactNode;
  children: ReactNode;
  onToggle: () => void;
}) {
  const panelId = useId();
  const reduce = useReducedMotion();
  return (
    <div
      className={cn(
        "relative rounded-xl border bg-sidebar-row-hover/30 p-1 shadow-xs",
        selected ? "border-primary/25" : "border-sidebar-border/70",
      )}
    >
      <div className="relative flex items-start gap-0.5 pl-7">
        <div className="min-w-0 flex-1">{header}</div>
        <button
          type="button"
          data-thread-selection-safe
          className="mt-1 flex min-h-7 min-w-7 shrink-0 items-center justify-center gap-0.5 rounded-md px-1 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring active:bg-sidebar-row-selected"
          aria-label={`${open ? "Collapse" : "Expand"} branches of ${title}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          {!open && <span className="text-3xs tabular-nums">{count}</span>}
          <motion.span
            animate={{ rotate: open ? 0 : -90 }}
            transition={{ duration: reduce ? 0 : 0.16 }}
          >
            <ChevronDownIcon className="size-3" />
          </motion.span>
        </button>
      </div>
      <motion.div
        id={panelId}
        initial={false}
        animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
        transition={reduce ? { duration: 0 } : { type: "spring", bounce: 0, duration: 0.35 }}
        className="overflow-hidden"
        inert={!open}
        aria-hidden={!open}
      >
        <div className="relative flex flex-col gap-1 pb-0.5 pl-7 pt-1">{children}</div>
      </motion.div>
    </div>
  );
}
