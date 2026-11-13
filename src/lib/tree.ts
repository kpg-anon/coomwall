// Changing one tile's size in a Mosaic layout tree by hand (a pinned tile,
// Shift+↑↓). Each split stores where its cut falls (`f`, the share of the
// split's width for a row and of its height for a column that goes to `a`),
// so moving the nearest cut on each axis above the tile resizes it without
// reordering anything: only the tiles inside those two splits change size,
// and every tile outside them keeps its exact rectangle.
import type { Rect, Tree } from "./api";

type Split = Extract<Tree, { k: "row" | "col" }>;

/** the splits from the root down to tile `id`, each with the side the tile is on and its rect */
function pathTo(t: Tree, id: number, r: Rect, out: { node: Split; inA: boolean; rect: Rect }[] = []): typeof out | null {
  if (t.k === "leaf") return t.id === id ? out : null;
  const [ra, rb] = t.k === "row" ? [{ ...r, w: r.w * t.f }, { ...r, x: r.x + r.w * t.f, w: r.w * (1 - t.f) }] : [{ ...r, h: r.h * t.f }, { ...r, y: r.y + r.h * t.f, h: r.h * (1 - t.f) }];
  out.push({ node: t, inA: true, rect: r });
  if (pathTo(t.a, id, ra, out)) return out;
  out[out.length - 1].inA = false;
  if (pathTo(t.b, id, rb, out)) return out;
  out.pop();
  return null;
}

/** how many tiles lie side by side across a subtree, along a row split's
 * axis (`row`) or a column split's: the most any line through it crosses */
function across(t: Tree, row: boolean): number {
  if (t.k === "leaf") return 1;
  const a = across(t.a, row);
  const b = across(t.b, row);
  return (t.k === "row") === row ? a + b : Math.max(a, b);
}

function leaves(t: Tree, out: number[] = []): number[] {
  if (t.k === "leaf") out.push(t.id);
  else {
    leaves(t.a, out);
    leaves(t.b, out);
  }
  return out;
}

export type ResizeResult = { tree: Tree } | { reason: "blocked" | "limit" | "alone" };

/** Tile `id` about `factor` times its area (both sides by √factor; by the
 * whole factor on one side when the other cannot change). A split that also
 * holds a tile in `keep` (other pinned tiles, the center) is not changed, so
 * those tiles never move. No tile on either side of a changed cut gets
 * thinner than `minPx`. */
export function resizeLeaf(tree: Tree, bounds: Rect, id: number, factor: number, keep: Set<number>, minPx = 90): ResizeResult {
  const copy: Tree = JSON.parse(JSON.stringify(tree));
  const path = pathTo(copy, id, bounds);
  if (!path || !path.length) return { reason: "alone" };
  // the nearest split of each kind: the one whose cut is the tile's own edge
  // on that axis, with only splits of the other kind between them
  const nearest = (k: "row" | "col") => {
    for (let i = path.length - 1; i >= 0; i--) if (path[i].node.k === k) return path[i];
    return null;
  };
  const axes = [nearest("row"), nearest("col")].filter((p) => p !== null);
  const free = axes.filter((p) => !leaves(p.node).some((x) => x !== id && keep.has(x)));
  if (!free.length) return { reason: axes.length ? "blocked" : "alone" };
  const k = free.length === 2 ? Math.sqrt(factor) : factor;
  let changed = false;
  for (const p of free) {
    const len = p.node.k === "row" ? p.rect.w : p.rect.h;
    const share = p.inA ? p.node.f : 1 - p.node.f;
    // each side keeps minPx for every tile across it, not only for the
    // tiles touching the cut
    const row = p.node.k === "row";
    const own = p.inA ? p.node.a : p.node.b;
    const other = p.inA ? p.node.b : p.node.a;
    const lo = Math.max(0.04, (minPx * across(own, row)) / len);
    const hi = 1 - Math.max(0.04, (minPx * across(other, row)) / len);
    if (lo >= hi) continue;
    const next = Math.max(lo, Math.min(hi, share * k));
    if (Math.abs(next - share) * len < 1) continue;
    p.node.f = p.inA ? next : 1 - next;
    changed = true;
  }
  return changed ? { tree: copy } : { reason: "limit" };
}
