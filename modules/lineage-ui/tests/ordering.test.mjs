import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupSidebarLineage, orderSidebarLineage } from "@radix/lineage-ui/ordering";

// The seven behavior cases are ported from the T3 fork's sidebarLineage.test.ts.
// Node's runner keeps the pure module checks independent of installed UI tooling.
describe("native sidebar lineage ordering", () => {
  it("groups a nested family once while preserving independent work priority", () => {
    const parents = new Map([
      ["child", "parent"],
      ["parent", "main"],
      ["sibling", "main"],
    ]);
    assert.deepEqual(
      groupSidebarLineage(
        ["child", "independent", "sibling", "main", "parent"],
        (key) => key,
        parents,
      ),
      [
        { key: "main", root: "main", entries: ["main", "sibling", "parent", "child"] },
        { key: "independent", root: "independent", entries: ["independent"] },
      ],
    );
  });

  it("does not fabricate an out-of-scope parent or duplicate descendants", () => {
    const parents = new Map([
      ["child", "pinned"],
      ["grandchild", "child"],
    ]);
    assert.deepEqual(groupSidebarLineage(["grandchild", "child"], (key) => key, parents), [
      { key: "child", root: "child", entries: ["child", "grandchild"] },
    ]);
    assert.deepEqual(groupSidebarLineage(["pinned"], (key) => key, parents), [
      { key: "pinned", root: "pinned", entries: ["pinned"] },
    ]);
  });

  it("keeps 128 threads across deep families addressable exactly once", () => {
    const entries = Array.from({ length: 128 }, (_, index) => `thread-${index}`);
    const parents = new Map(
      entries
        .slice(1)
        .filter((_, index) => (index + 1) % 32 !== 0)
        .map((key) => [key, `thread-${Number(key.slice(7)) - 1}`]),
    );
    const families = groupSidebarLineage(entries.toReversed(), (key) => key, parents);
    assert.equal(families.length, 4);
    assert.deepEqual(families.map((family) => family.entries.length), [32, 32, 32, 32]);
    assert.deepEqual(new Set(families.flatMap((family) => family.entries)), new Set(entries));
  });

  it("keeps descendants contiguous and puts each parent first", () => {
    const parents = new Map([
      ["child", "parent"],
      ["parent", "main"],
      ["sibling", "main"],
    ]);
    assert.deepEqual(
      orderSidebarLineage(
        ["main", "child", "parent", "sibling", "independent"],
        (key) => key,
        parents,
      ),
      ["main", "parent", "child", "sibling", "independent"],
    );
  });

  it("retains native family priority and treats missing parents as out of view", () => {
    assert.deepEqual(
      orderSidebarLineage(
        ["b-child", "a", "b", "orphan"],
        (key) => key,
        new Map([
          ["b-child", "b"],
          ["orphan", "missing"],
        ]),
      ),
      ["b", "b-child", "a", "orphan"],
    );
  });

  it("terminates on corrupt cycles and includes every visible row once", () => {
    const result = orderSidebarLineage(
      ["a", "b", "c"],
      (key) => key,
      new Map([
        ["a", "b"],
        ["b", "a"],
      ]),
    );
    assert.deepEqual(new Set(result), new Set(["a", "b", "c"]));
    assert.equal(result.length, 3);
  });

  it("keeps scoped addresses distinct without using titles for identity", () => {
    const entries = ["env1:child", "env2:parent", "env1:parent"];
    assert.deepEqual(
      orderSidebarLineage(entries, (key) => key, new Map([["env1:child", "env1:parent"]])),
      ["env1:parent", "env1:child", "env2:parent"],
    );
  });
});
