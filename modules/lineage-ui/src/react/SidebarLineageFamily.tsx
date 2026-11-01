import { createRef, type ReactNode, useMemo, useRef } from "react";
import { cn } from "../classNames.ts";
import { AnimatedBeam } from "./AnimatedBeam.tsx";
import { TaskGroup } from "./TaskGroup.tsx";

export interface LineageRow {
  key: string;
  title: string;
  running: boolean;
}

export interface SidebarLineageFamilyProps {
  rows: ReadonlyArray<LineageRow>;
  parents: ReadonlyMap<string, string>;
  activeKey: string | null;
  open: boolean;
  onToggle: () => void;
  renderRow: (key: string, hidden: boolean) => ReactNode;
}

/**
 * Sidebar supplies scoped identities, native parents and observed row state.
 * This adapter owns presentation only; navigation, selection, menus and drag stay
 * with renderRow. Product decisions and host contract: ../../design.md (module root).
 */
export function SidebarLineageFamily({
  rows,
  parents,
  activeKey,
  open,
  onToggle,
  renderRow,
}: SidebarLineageFamilyProps) {
  const containerRef = useRef<HTMLLIElement>(null);
  const keys = rows.map((row) => row.key).join("|");
  const refs = useMemo(
    () => new Map(keys.split("|").map((key) => [key, createRef<HTMLSpanElement>()])),
    [keys],
  );
  const root = rows[0]!;
  const selectedPath = new Set<string>();
  let cursor = activeKey;
  while (cursor && refs.has(cursor) && !selectedPath.has(cursor)) {
    selectedPath.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  const livePath = new Set(selectedPath);
  for (const row of rows) {
    if (!row.running) continue;
    const seen = new Set<string>();
    let current: string | undefined = row.key;
    while (current && refs.has(current) && !seen.has(current)) {
      seen.add(current);
      livePath.add(current);
      current = parents.get(current);
    }
  }
  const render = (row: LineageRow, header: boolean) => (
    <div
      className={cn(
        "relative min-w-0",
        !header && "rounded-lg border border-sidebar-border/50 bg-sidebar/60",
      )}
    >
      <span
        ref={refs.get(row.key)}
        aria-hidden="true"
        data-lineage-port={row.key}
        className={cn(
          "absolute -left-0.5 top-5 z-10 size-1 rounded-full",
          livePath.has(row.key) ? "bg-primary" : "bg-sidebar-muted-foreground/45",
        )}
      />
      <ul role="presentation" className="relative z-10 min-w-0">
        {renderRow(row.key, !header && !open)}
      </ul>
    </div>
  );
  return (
    <li
      ref={containerRef}
      role="presentation"
      className="relative mb-1 list-none"
      data-lineage-family={root.key}
    >
      <TaskGroup
        title={root.title}
        open={open}
        count={rows.length - 1}
        selected={activeKey !== null && refs.has(activeKey)}
        header={render(root, true)}
        onToggle={onToggle}
      >
        {rows.slice(1).map((row) => (
          <div key={row.key}>{render(row, false)}</div>
        ))}
      </TaskGroup>
      {open &&
        rows.slice(1).map((row) => {
          const parent = parents.get(row.key);
          const from = parent ? refs.get(parent) : undefined;
          const to = refs.get(row.key);
          if (!from || !to) return null;
          const live = livePath.has(row.key);
          return (
            <AnimatedBeam
              key={`${parent}:${row.key}`}
              containerRef={containerRef}
              fromRef={from}
              toRef={to}
              motionKey={`${open}:${activeKey}:${row.running}:${keys}`}
              animated={live}
              continuous={live}
              pathOffset={parent === root.key ? 24 : 12}
              duration={2}
              repeatDelay={0}
              pathWidth={1.25}
              pathColor={live ? "var(--primary)" : "var(--sidebar-muted-foreground)"}
              pathOpacity={live ? 0.55 : 0.25}
              gradientStartColor="var(--primary)"
              gradientStopColor="var(--sidebar-foreground)"
            />
          );
        })}
    </li>
  );
}
