// The wall's keys, for the help overlay (?) and the preferences dialog.
// Wall.svelte handles them; keep the two in step.

export interface KeyRow {
  /** each one drawn as a key */
  keys: string[];
  /** plain words after the keys: "double-click", "right-click" */
  also?: string;
  does: string;
}

export function wallKeys(rateKeys: "list" | "fine", rateList: number[]): KeyRow[] {
  const speed =
    rateKeys === "list" && rateList.length
      ? `playback speed, slower or faster through ${rateList.map((r) => `${r}×`).join(" ")} · with Shift, by 0.05`
      : "playback speed by 0.05 · with Shift, by 0.25";
  return [
    { keys: ["Space"], does: "pause or resume this wall · with Shift, every wall" },
    { keys: ["1", "–", "6"], does: "Mosaic · Ribbon · Cascade · Dynamic · Grid · Stack, without leaving the wall" },
    { keys: ["+", "−"], does: "one more or one fewer tile, row, column or Stack pane" },
    { keys: ["↑", "↓"], does: "feed speed · Dynamic: how often · Grid: rows · Mosaic: the centered media's size" },
    { keys: ["Shift", "↑", "↓"], does: "the size of the pinned tile under the pointer, or of the centered media, in any mode" },
    { keys: ["D"], does: "reverse the feed's direction · Stack: row or column" },
    { keys: ["[", "]"], does: speed },
    { keys: ["N"], does: "next item in the tile under the pointer · after B, forward again to where it was · Stack: the next item" },
    { keys: ["B"], does: "the item that tile showed before; each tile remembers its last 20 · Stack: the item before" },
    { keys: ["P"], does: "pin it: it keeps playing and nothing moves it · Stack: the item loops instead of moving on" },
    { keys: [], also: "Shift+drag", does: "move the picture inside a pinned or centered tile that crops it · Shift+double-click centers it again" },
    { keys: [], also: "Shift+wheel", does: "zoom into a pinned or centered tile, toward the pointer (up to 8×) · Shift+drag then moves around in it" },
    { keys: ["M"], does: "sound on or off for the item under the pointer; other items keep theirs" },
    { keys: ["Shift", "M"], does: "sound off for every item, on every wall" },
    { keys: ["F"], also: "double-click", does: "view it whole: wheel to zoom, drag to pan, R to turn" },
    { keys: ["C"], does: "make it the centered media, in any mode · on the centered media, or with nothing under the pointer: centering off or on" },
    { keys: ["O"], does: "show the file in Explorer" },
    { keys: [], also: "right-click", does: "show in Explorer, open in the default app, make it the centered media, stack it, previous or next item in its tile, remove from the wall, never show again" },
    { keys: ["T"], does: "keep the walls above every other window, or stop" },
    { keys: ["Ctrl", "Shift", "←", "→", "↑", "↓"], does: "move this wall to the display on that side; a wall there swaps with it" },
    { keys: ["Ctrl", "S"], does: "save the wall under a name, to load again from setup · with a wall on each display, every wall" },
    { keys: ["R"], does: "lay the wall out again · Grid: new items · feeds: refill · Stack: turn the panes" },
    { keys: ["G"], does: "show where each change happens" },
    { keys: ["?"], does: "these keys" },
    { keys: ["Esc"], does: "back to setup" },
  ];
}
