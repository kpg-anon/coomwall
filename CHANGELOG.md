# Changelog

All notable changes to **coomwall** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Touchscreen gestures.** Two fingers pinch to zoom toward the point between them, and one finger drags: in the viewer, on a pinned tile or the center tile in Mosaic, Dynamic and Grid (as `Shift`+wheel and `Shift`+drag), and in Stack. A finger held still for about half a second pins or unpins the tile under it, or Stack's item, as `P` does; where there is nothing to pin (the viewer, Ribbon, Cascade, the center tile) it opens the item's menu. A quick tap with two fingers opens the item's menu, as a right-click does. WebView2's own pinch zoom of the whole page is turned off.
- **Reset** (setup, at the top of Mode; with a wall on each display, next to the display tabs): puts the mode and every mode's settings, Show / Shape / Size, and Centered media (off, and its size) back to their defaults, on every display. The first click asks, a second click within 4 seconds resets. Your folders, the chosen centered file, Stack's file or link, and Playback and Layout in the right-hand column stay. It shows only while something differs from the defaults.

### Fixed
- **The setup page in a narrow window.** Below 1100 px wide (a display turned upright gives a window about 960 px wide) the Show, Shape, Size and Order choices ran out of the right-hand card and the mode names out of their cards. The right-hand card now goes under the main one in such a window. In a window too short for the page, the page scrolls and the Start button stays at the bottom of the window; before, it scrolled out of view.
- With the right-click menu open, a click outside it also went on to whatever was under the pointer: in the viewer, a click on the background closed the menu and the viewer together. That click now only closes the menu.

## [1.0.4] — 2026-11-24

### Added
- **A seek bar on the video under the pointer**, in every mode: a thin line along its bottom edge shows how far it has played; click or drag on it to jump. It shows while the wall's controls do, and not with **The wall's top and bottom bars** hidden. Until now a video on the wall could only be moved through in the viewer (`F`).
- **Sound on the newest video only** (Preferences → Behavior → Sound → **Newest video**): only the video that appeared last has sound, and the next one to appear takes it over. With a wall on each display, that is the newest video on any of them. An item open whole (`F`) has the sound while it is open.
- **Run the wall in a window** (Preferences → General): the wall opens in a normal window with a title bar, which you can move and resize, instead of filling the display. With a wall on each display, each one is a window on its display. `F11` on a running wall switches it between a window and fullscreen.
- **Reset the grid on every display** (setup, under the Grid drawing, with a wall on each display): every display's grid goes back to 3×1 with no merged cells. It shows while any display has a different grid.

### Changed
- Sound is now one choice instead of two checkboxes (Preferences → Behavior → Sound): **Picked with M**, **Also the pointer**, **Every video** or **Newest video**. Your earlier choice carries over.
- `Shift`+`M` no longer turns off **Every video** in your settings. It turns sound off until the next start of the wall, and the setting stays as it was.

### Fixed
- `Ctrl`+`J` opened WebView2's Downloads panel. The browser keys of WebView2 (Downloads, History, Print, Find, Reload, DevTools and the others) are now turned off in the window itself.

## [1.0.3] — 2026-11-16

### Changed
- The viewer's video controls (play, seek, time, sound) are now a setting of their own: Preferences → Behavior → Hide → **The viewer's video controls**. **The viewer's top and bottom bars** (called **In the viewer** in 1.0.2) now hides only the name and tools bar and the key list. If you had it on in 1.0.2, the video controls stay hidden too.

## [1.0.2] — 2026-11-16

### Added
- **Hide the top and bottom bars** (Preferences → Behavior, both off by default), with two separate checkboxes:
  - **On the wall**: the wall never shows its bars, also when the pointer moves. Messages, the `?` key list and the pointer still appear; `Esc` goes back to setup.
  - **In the viewer**: one item opened whole (`F` or a double-click) shows no name, tools, video controls or key list. The keys still work: `Space` plays, `←` `→` seek, `Esc` closes.

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
