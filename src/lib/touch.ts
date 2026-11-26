// Fingers on a touchscreen. Chromium sends each finger as its own pointer
// (pointerType "touch"). `Fingers` keeps where each one is and turns every
// move into a step: where the finger, or the middle of the first two, was,
// how far it moved, and how much farther apart the two are. One finger
// drags, two pinch and drag together.
//
// A step is measured from where the fingers are, not from where the gesture
// began, so lifting one of two fingers carries on as a one-finger drag
// without a jump.

export interface Step {
  /** the finger, or the middle of the two, before this move (client px) */
  x: number;
  y: number;
  /** how far that point moved */
  dx: number;
  dy: number;
  /** the two fingers' distance after this move over before (1 with one finger) */
  k: number;
  fingers: number;
}

/** two fingers closer than this are too close to measure a pinch by */
const MIN_SPREAD = 24;

export class Fingers {
  private at = new Map<number, { x: number; y: number }>();
  /** how far the fingers have moved since the first one went down (px) */
  travel = 0;
  /** the most fingers down at once since the first one went down */
  most = 0;

  get count(): number {
    return this.at.size;
  }

  /** a touch pointer went down; false (and ignored) for a mouse or pen */
  down(e: PointerEvent): boolean {
    if (e.pointerType !== "touch") return false;
    if (!this.at.size) this.travel = this.most = 0;
    this.at.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.most = Math.max(this.most, this.at.size);
    return true;
  }

  /** a finger lifted or was cancelled; false when it was not one of these */
  up(e: PointerEvent): boolean {
    return this.at.delete(e.pointerId);
  }

  /** the step for this move; null for another pointer or a third finger */
  move(e: PointerEvent): Step | null {
    if (!this.at.has(e.pointerId)) return null;
    const ids = [...this.at.keys()].slice(0, 2);
    if (!ids.includes(e.pointerId)) {
      this.at.set(e.pointerId, { x: e.clientX, y: e.clientY });
      return null;
    }
    const before = this.shape(ids);
    this.at.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const after = this.shape(ids);
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    this.travel += Math.abs(dx) + Math.abs(dy) + Math.abs(after.d - before.d);
    const k = ids.length === 2 && before.d >= MIN_SPREAD && after.d >= MIN_SPREAD ? after.d / before.d : 1;
    return { x: before.x, y: before.y, dx, dy, k, fingers: ids.length };
  }

  /** the middle of these fingers and their distance apart */
  private shape(ids: number[]): { x: number; y: number; d: number } {
    const a = this.at.get(ids[0])!;
    const b = this.at.get(ids[1] ?? ids[0])!;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  }
}
