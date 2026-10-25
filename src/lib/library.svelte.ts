// The sources the user added and what scanning them found.
import { api, type MediaEntry } from "./api";
import { settings } from "./settings.svelte";

class Library {
  items = $state.raw<MediaEntry[]>([]);
  images = $state(0);
  videos = $state(0);
  known = $state(0);
  errors = $state<string[]>([]);
  scanning = $state(false);
  millis = $state(0);
  private generation = 0;

  async rescan() {
    const gen = ++this.generation;
    const sources = [...settings.s.sources];
    if (!sources.length) {
      this.items = [];
      this.images = this.videos = this.known = 0;
      this.errors = [];
      this.scanning = false;
      return;
    }
    this.scanning = true;
    try {
      const r = await api.scan(sources, settings.s.recursive);
      if (gen !== this.generation) return;
      this.items = r.items;
      this.images = r.images;
      this.videos = r.videos;
      this.known = r.known;
      this.errors = r.errors;
      this.millis = r.millis;
    } catch (e) {
      if (gen === this.generation) this.errors = [String(e)];
    } finally {
      if (gen === this.generation) this.scanning = false;
    }
  }

  add(paths: string[]) {
    const have = new Set(settings.s.sources.map((p) => p.toLowerCase()));
    const fresh = paths.filter((p) => p && !have.has(p.toLowerCase()));
    if (!fresh.length) return;
    settings.s.sources = [...settings.s.sources, ...fresh];
    this.rescan();
  }

  remove(path: string) {
    settings.s.sources = settings.s.sources.filter((p) => p !== path);
    this.rescan();
  }

  /** what the current type filter would play */
  playable(): number {
    const t = settings.s.type;
    return t === "images" ? this.images : t === "videos" ? this.videos : this.images + this.videos;
  }
}

export const library = new Library();
