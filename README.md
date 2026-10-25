<div align="center">

<img src="static/icon.png" alt="coomwall" width="96">

# coomwall

**Point it at folders of images and videos. Pick a mode. Everything plays at once, on one screen.**

</div>

---

## What it is

`coomwall` fills a monitor with your media: images, GIFs and videos of any size and shape, all on one surface, all playing at once. It is a desktop app (Tauri v2 + Svelte + Rust), with no command line to learn.

It is the GUI successor to `coomplexer grid --mix`. That tool tiled one mpv window per screen region, so a tile could never move or resize while it played, every tile had to be 9:16 or 16:9, and finished tiles froze until their neighbours caught up. Here every tile is a rectangle on one GPU-composited surface, so the layout can change smoothly while everything keeps playing.

## Modes

| Mode | What it does |
| --- | --- |
| **Mosaic** | A fixed number of tiles (1–16) filling the screen. When a tile's item ends, the next one takes its place, and the layout changes only as much as it has to. See [How Mosaic stays still](#how-mosaic-stays-still). |
| **Ribbon** | Rows that travel left (or right) at a constant speed. Every item keeps its own shape along the row, so nothing is cropped. |
| **Cascade** | Columns that travel up (or down), like a slow feed. |

You can switch modes from the wall with `1` `2` `3`. The shuffle carries on where it was.

## Using it

1. **Add sources.** Drop folders or `.m3u` playlists on the window, or click to choose. Subfolders are included unless you turn that off. Hidden folders such as comfysort's `.trash` are skipped.
2. **Pick a mode** and its one or two numbers: tiles and stillness for Mosaic, rows or columns plus direction and speed for the feeds.
3. **Pick what to show:** everything, videos only or images only, and any shape, portrait only or landscape only.
4. **Start the wall** with `Enter`. It goes fullscreen on the display you chose. `Esc` comes back.

### A wall on each display

With more than one display, tick **A wall on each display** next to Mode. A small map shows your displays as Windows arranges them. Click one, then pick its mode and numbers below; untick **Wall on this display** to leave it free. Each display remembers its own mode, count, direction, speed and stillness. Sources, filters and everything under More options are shared.

`Enter` opens every wall at once and the setup window steps aside. On the walls:

- Keys go to the wall under the pointer.
- `Space` pauses or resumes all of them, and `M` moves the one item with sound to the wall you are on.
- `Esc` on any wall closes all of them. Closing one with `Alt+F4` leaves the others running; setup comes back when the last one closes.
- Each wall shuffles on its own, so with a small folder the same file can appear on two displays at once.

Everything else (image duration, a video length cap, looping short clips, playback speed, gap, crop limit, what happens under the pointer, when the wall pauses by itself, display, graphics adapter, theme) is under **More options**. Every setting is remembered.

### Keys on the wall

| Key | Does |
| --- | --- |
| `Space` | pause or resume everything |
| `1` `2` `3` | Mosaic · Ribbon · Cascade |
| `+` `−` | one more or one fewer tile, row or column |
| `↑` `↓` | feed speed |
| `D` | reverse the feed's direction |
| `[` `]` | playback speed |
| `N` | next item in the tile under the pointer |
| `P` | pin it: it keeps playing, and no other change moves it |
| `M` | sound on for the item under the pointer (only one item has sound) |
| `F`, double-click | view it whole, uncropped |
| `O` | show the file in Explorer |
| `R` | Mosaic: lay the whole wall out again · feeds: refill |
| `G` | outline each Mosaic change as it happens |
| `?` | all keys |
| `Esc` | back to setup |

The interface only appears while the pointer moves. Otherwise the screen is media only.

## How Mosaic stays still

The rule is that **the thing you are looking at must not jump.**

- **The layout is a slicing tree that stores its cuts.** Each split remembers where its cut falls instead of deriving it from what is inside. So one block of the wall can be rebuilt while every tile outside that block keeps its exact pixels.
- **Smallest change first.** When a tile ends, the solver tries the cheapest option first: put the next item in the same tile with no movement at all. Only if that would crop the item too much does it try re-laying out the tile's parent block, then the grandparent, and so on up to 8 tiles. Each block is solved exactly by dynamic programming over the block's items, for that block's fixed rectangle.
- **Fit-aware queue.** It looks at the next 10 queued items and prefers one whose shape fits the empty slot. An item can be passed over at most 6 times before it is placed anyway, but never into the tile you are watching.
- **Every option is scored.** Each candidate layout is scored on crop, size spread, and motion. Motion is how far tiles already on screen would move or resize, measured in tile sizes, and weighted by the **Stillness** setting. A tile that changed or moved in the last 5 s counts three times, and a pinned tile counts twelve times.
- **The tile under the pointer is frozen.** No other change may move it. When its own item ends, the item plays again (up to twice) and is then replaced in place with the best-fitting item in the queue.
- **Changes are spaced out.** A change that moves tiles gets its full 0.7 s transition before the next one starts. For 3 s after any move, motion costs four times as much, so the next few changes are content swaps unless a swap would crop badly. Content changes cross-fade only after the new item's first frame is decoded, so a tile never shows an empty frame.
- **Whole-wall re-layouts are rare.** A re-layout of every tile is used at most once a minute, and only when no smaller block can take any queued item within the crop limit. A crop past the limit for a few seconds is easier to watch than every tile moving. `R` re-lays out the whole wall on demand.

In the engine's 3,000-change test on a 9-tile wall of mixed shapes:

- 88% of changes were pure content swaps.
- On average 0.18 tiles moved per change.
- No tile ever had more than 30% of its media cropped.
- Each decision took about 8 ms.

## Install / build

Requirements: Node 20+, Rust stable, and on Windows the WebView2 runtime (already part of Windows 11).

```console
npm install
npm run tauri dev       # run it
npm run tauri build     # installer in target/release/bundle
cargo test -p coomwall-engine   # solver, scanner, cache and Range-header tests
```

On the windows-gnu toolchain the first `tauri build` needs `WebView2Loader.dll` in `target/release` before it has built it. After one `tauri dev`, copy it over: `cp target/debug/WebView2Loader.dll target/release/`.

### Graphics adapter

**More options → Graphics** picks the GPU that decodes and composites everything: the Windows default (for WebView2 that is the power-saving one), High performance or Power saving. It is passed to WebView2 as `--use-adapter-luid`, so a change needs a restart; the setup screen offers one.

On a hybrid laptop the displays are wired to the integrated GPU, and with High performance every frame is copied across to it. Measured on an XPS 17 9730 (Iris Xe + RTX 4070 Laptop), Ribbon with 4 rows of 1080p60 clips:

| Wall on | Windows default (Iris Xe) | High performance (RTX 4070) |
| --- | --- | --- |
| 1920×1200 external monitor | 36% of frames dropped, 34 fps | 6% dropped, 59 fps |
| 3840×2400 built-in panel | 37% dropped, 35 fps | videos played at about 5% speed |

### Formats

Playback is the system WebView's (Chromium on Windows). These work:

- MP4, WebM, MOV and MKV with H.264, VP9 or AV1
- JPG, PNG, WebP, AVIF, GIF and BMP

HEVC plays only when Windows has a working HEVC decoder (the HEVC Video Extensions). Files that cannot be decoded are skipped, and the HUD counts them.

## Layout

```
crates/engine/      pure Rust: scan.rs (folders, playlists), cache.rs (known dimensions),
                    layout.rs (the Mosaic solver and its tests), patch.rs (settings merge)
src-tauri/          Tauri shell: commands.rs (IPC), media.rs (the cw:// file server
                    with HTTP Range support, so large videos seek without loading whole),
                    walls.rs (one window per display)
src/lib/            Svelte 5 frontend: queue, Mosaic and feed controllers, components
```

## License

MIT
