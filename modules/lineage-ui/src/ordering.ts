/** Keep native priority between families, then put each parent before its descendants. */
export function orderSidebarLineage<T>(
  entries: ReadonlyArray<T>,
  keyOf: (entry: T) => string,
  sourceParents: ReadonlyMap<string, string>,
): T[] {
  const byKey = new Map(entries.map((entry) => [keyOf(entry), entry]));
  const parents = new Map<string, string>();
  for (const [key, parent] of sourceParents) {
    if (byKey.has(key) && byKey.has(parent) && key !== parent) parents.set(key, parent);
  }
  const roots = new Map<string, string>();
  for (const key of byKey.keys()) {
    const path: string[] = [],
      seen = new Set<string>();
    let cursor = key;
    while (!roots.has(cursor) && parents.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      path.push(cursor);
      cursor = parents.get(cursor)!;
    }
    if (seen.has(cursor)) parents.delete(cursor);
    const root = roots.get(cursor) ?? cursor;
    roots.set(cursor, root);
    for (const item of path) roots.set(item, root);
  }
  const children = new Map<string, string[]>();
  for (const key of byKey.keys()) {
    const parent = parents.get(key);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), key]);
  }
  const rootOrder = [...new Set([...byKey.keys()].map((key) => roots.get(key)!))];
  const stack = rootOrder.toReversed(),
    result: T[] = [],
    emitted = new Set<string>();
  while (stack.length) {
    const key = stack.pop()!;
    if (emitted.has(key)) continue;
    emitted.add(key);
    result.push(byKey.get(key)!);
    stack.push(...(children.get(key) ?? []).toReversed());
  }
  return result;
}

export interface SidebarLineageFamily<T> {
  key: string;
  root: T;
  entries: T[];
}

/** Group only supplied visible members. Presentation never changes native ancestry. */
export function groupSidebarLineage<T>(
  entries: ReadonlyArray<T>,
  keyOf: (entry: T) => string,
  sourceParents: ReadonlyMap<string, string>,
): SidebarLineageFamily<T>[] {
  const families: SidebarLineageFamily<T>[] = [];
  const familyByMember = new Map<string, SidebarLineageFamily<T>>();
  for (const entry of orderSidebarLineage(entries, keyOf, sourceParents)) {
    const key = keyOf(entry);
    const parent = sourceParents.get(key);
    let family = parent ? familyByMember.get(parent) : undefined;
    if (!family) {
      family = { key, root: entry, entries: [] };
      families.push(family);
    }
    family.entries.push(entry);
    familyByMember.set(key, family);
  }
  return families;
}
