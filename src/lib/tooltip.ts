// Hover text in the app's own style, instead of WebView2's native tooltip.
// Any element with a `title` works as before: on the first hover its title
// moves to data-tip (so the native tooltip never shows) and this one shows
// it. Svelte may set `title` again when it changes; the next hover picks
// that up.

const DELAY = 450;
const GAP = 10;

export function installTooltips(): () => void {
  const tip = document.createElement("div");
  tip.className = "cw-tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);

  let target: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let px = 0;
  let py = 0;

  const text = (el: HTMLElement): string => {
    // a title set (or set again) since the last hover wins
    const t = el.getAttribute("title");
    if (t !== null) {
      el.dataset.tip = t;
      el.removeAttribute("title");
    }
    return el.dataset.tip ?? "";
  };

  const place = () => {
    if (!target) return;
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    // under the element, level with the pointer; above it if there is no room
    let x = Math.min(Math.max(8, px - w / 2), innerWidth - w - 8);
    let y = r.bottom + GAP;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - GAP - h);
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  const hide = () => {
    clearTimeout(timer);
    target = null;
    tip.classList.remove("on");
  };

  const over = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.<HTMLElement>("[title], [data-tip]") ?? null;
    if (el === target) return;
    hide();
    if (!el) return;
    const t = text(el);
    if (!t) return;
    target = el;
    px = e.clientX;
    py = e.clientY;
    timer = setTimeout(() => {
      if (target !== el) return;
      tip.textContent = t;
      tip.classList.add("on");
      place();
    }, DELAY);
  };

  const move = (e: PointerEvent) => {
    px = e.clientX;
    py = e.clientY;
    if (tip.classList.contains("on")) place();
  };

  const out = (e: PointerEvent) => {
    // left the window, or went to an element with no hover text
    if (!e.relatedTarget) hide();
  };

  window.addEventListener("pointerover", over, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerout", out, true);
  window.addEventListener("pointerdown", hide, true);
  window.addEventListener("keydown", hide, true);
  window.addEventListener("wheel", hide, { capture: true, passive: true });
  window.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
  return () => {
    hide();
    tip.remove();
    window.removeEventListener("pointerover", over, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerout", out, true);
    window.removeEventListener("pointerdown", hide, true);
    window.removeEventListener("keydown", hide, true);
    window.removeEventListener("wheel", hide, true);
    window.removeEventListener("scroll", hide, true);
    window.removeEventListener("blur", hide);
  };
}
