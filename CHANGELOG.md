# Changelog

All notable changes to **coomwall** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] — 2026-11-14

### Added
- **Sound on every video** (Preferences → Behavior, off by default): every video on the wall plays with sound at once, instead of only the items you pick with `M`. `Shift`+`M` on a wall turns it off until the next start.

## [1.0.0] — 2026-11-14

The first public release.

### Added
- **Six modes.** **Mosaic** (tiles of about one size; one block changes at a time and the tile you watch never moves), **Ribbon** and **Cascade** (rows or columns that glide, every item at its own shape), **Dynamic** (the newest item gets the largest tile), **Grid** (fixed cells, presets, typed layouts such as `5x2`, merged cells) and **Stack** (one item in 1–6 panes, every pane on the same frame).
- **Centered media** in every mode: one file in the middle, built into the wall with no gaps and never drawn on top.
- **Links in Stack.** Paste a YouTube link (or any page yt-dlp knows): **Stream** plays it straight from the site, **Download first** keeps a copy. Page links inside `.m3u` playlists play the same way in every mode.
- **A wall on each display**, each with its own mode, folders and filters. `Ctrl`+`Shift`+arrow moves a wall to the next display while its media keeps playing.
- **Saved walls.** The last wall saves itself as it runs; `Ctrl`+`S` saves it under a name. The **Saved walls** panel shows a drawing of each display's tiles, and **Load** brings back the same files in the same tiles with their pins, zoom, sound and video positions.
- **Pin, zoom and resize.** `P` pins a tile, `Shift`+wheel zooms into it, `Shift`+drag frames it, `Shift`+`↑` `↓` make it larger or smaller while only its neighbors make room.
- **The viewer** (`F` or double-click): one item whole, with zoom, pan, frame stepping, turning and mirroring.
- **Filters and order:** videos or images, portrait or landscape, a minimum size (480, 720 or 1080 px), a maximum video length, and shuffle, newest first or folder order.
- **Right-click** on any item: show in Explorer, open, center it, stack it, previous or next item, remove from the wall, never show again.
- **Preferences** in tabs: theme, behavior under the pointer, automatic pausing, keys, Grid fit, graphics adapter, color handling, yt-dlp cookies, and updates.
- **In-app updates.** coomwall checks GitHub for a newer release on launch (Preferences → General), shows its changelog, and installs it on **Update now**.
- **Portable zip.** `coomwall_<version>_x64-portable.zip` runs without installing. It keeps settings, saved walls, the cache and the browser profile in a `coomwall-data` folder next to `coomwall.exe`. Its update notice offers the new zip instead of running the installer.
