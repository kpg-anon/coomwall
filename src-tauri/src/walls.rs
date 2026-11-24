//! Several walls at once: one window per display, fullscreen or (with the
//! "run the wall in a window" setting) a normal window on it, each running
//! its own wall (the frontend reads which display from `window.__CW_WALL__`).
//! The setup window hides while they run and comes back when the last one
//! closes, however it was closed.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::utils::config::WindowConfig;
use crate::commands::{swap_wall_layouts, AppState};
use coomwall_engine::displays::{neighbor, Dir, Screen};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, State, WebviewWindow, Window, WindowEvent};

pub const PREFIX: &str = "wall-";

/// The main window's final config. WebView2 runs every webview of the app in
/// one environment, and a window asking for other browser args or another
/// profile folder fails to open, so wall windows copy it.
pub struct Template {
    pub config: WindowConfig,
    pub data_dir: Option<PathBuf>,
}

static NEXT: AtomicU32 = AtomicU32::new(1);

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// A window on display `m` that is not fullscreen: two thirds of its work
/// area (the display less the taskbar), in the middle of it.
pub fn window_rect(m: &Monitor) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let a = m.work_area();
    let size = PhysicalSize::new(a.size.width * 2 / 3, a.size.height * 2 / 3);
    let pos = PhysicalPosition::new(a.position.x + ((a.size.width - size.width) / 2) as i32, a.position.y + ((a.size.height - size.height) / 2) as i32);
    (pos, size)
}

/// Open a wall on each named display, then hide the setup window. Returns how
/// many opened; displays that are no longer connected are skipped. With
/// `windowed` each wall is a normal window with a title bar instead of
/// fullscreen.
// async: creating a window from a synchronous command deadlocks on Windows
#[tauri::command]
pub async fn open_walls(app: AppHandle, template: State<'_, Template>, monitors: Vec<String>, windowed: bool) -> Result<usize, String> {
    let all = app.available_monitors().map_err(err)?;
    let cursor = app.cursor_position().ok();
    let mut focus = None;
    let mut opened = 0;
    // one number for this start of the walls: their saves into the `last`
    // session join each other and replace the one before (sessions.rs)
    let run = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    for name in &monitors {
        let Some(m) = all.iter().find(|m| m.name().is_some_and(|n| n == name)) else {
            continue;
        };
        let mut cfg = template.config.clone();
        cfg.label = format!("{PREFIX}{}", NEXT.fetch_add(1, Ordering::Relaxed));
        cfg.visible = false;
        cfg.center = false;
        cfg.decorations = windowed;
        // small enough to sit inside any display before going fullscreen, so
        // Windows fullscreens it on the one it was moved to
        cfg.width = 640.0;
        cfg.height = 400.0;
        cfg.min_width = None;
        cfg.min_height = None;
        // in the title bar of a wall in a window, and on the taskbar
        // (Windows names displays \\.\DISPLAY2)
        cfg.title = format!("coomwall · {}", name.trim_start_matches(r"\\.\"));
        let mut builder = tauri::WebviewWindowBuilder::from_config(&app, &cfg)
            .map_err(err)?
            .initialization_script(format!("window.__CW_WALL__ = {}; window.__CW_RUN__ = {run};", serde_json::to_string(name).map_err(err)?));
        if let Some(dir) = &template.data_dir {
            builder = builder.data_directory(dir.clone());
        }
        let w = builder.build().map_err(err)?;
        crate::browser_keys_off(&w);
        let (pos, size) = (m.position(), m.size());
        let placed = if windowed {
            let (at, sz) = window_rect(m);
            w.set_size(sz).and_then(|_| w.set_position(at)).and_then(|_| w.show())
        } else {
            w.set_position(PhysicalPosition::new(pos.x + 60, pos.y + 60)).and_then(|_| w.set_fullscreen(true)).and_then(|_| w.show())
        };
        if let Err(e) = placed {
            // a hidden wall window left behind would count as a wall still
            // open, and setup would never come back
            let _ = w.destroy();
            return Err(err(e));
        }
        let inside = cursor.is_some_and(|c| {
            c.x >= pos.x as f64 && c.y >= pos.y as f64 && c.x < (pos.x + size.width as i32) as f64 && c.y < (pos.y + size.height as i32) as f64
        });
        if inside || focus.is_none() {
            focus = Some(w);
        }
        opened += 1;
    }
    if opened == 0 {
        return Err("None of the chosen displays is connected.".into());
    }
    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(err)?;
    }
    // keys go to the wall under the pointer
    if let Some(w) = focus {
        let _ = w.set_focus();
    }
    Ok(opened)
}

#[derive(Serialize, Clone)]
pub struct Moved {
    label: String,
    monitor: String,
}

/// Put a wall on another display. A fullscreen one leaves fullscreen,
/// shrinks so it fits inside the target, moves there and goes fullscreen
/// again. One in a window keeps its size where the target has room for it,
/// and goes to the middle of the target's work area.
fn place(w: &WebviewWindow, m: &Monitor) -> tauri::Result<()> {
    if !w.is_fullscreen()? {
        let a = m.work_area();
        let outer = w.outer_size()?;
        if outer.width > a.size.width || outer.height > a.size.height {
            let (at, sz) = window_rect(m);
            w.set_size(sz)?;
            return w.set_position(at);
        }
        let x = a.position.x + ((a.size.width - outer.width) / 2) as i32;
        let y = a.position.y + ((a.size.height - outer.height) / 2) as i32;
        return w.set_position(PhysicalPosition::new(x, y));
    }
    w.set_fullscreen(false)?;
    w.set_size(PhysicalSize::new(640, 400))?;
    let p = m.position();
    w.set_position(PhysicalPosition::new(p.x + 60, p.y + 60))?;
    w.set_fullscreen(true)
}

/// Ctrl+Shift+arrow on a wall: move it to the display on that side. A wall
/// already there moves the other way, so the two swap; with one wall per
/// display their layouts swap in settings.json too. The windows keep their
/// media playing. `wall-moved` carries each moved window and its new display.
#[tauri::command]
pub async fn move_wall(app: AppHandle, state: State<'_, AppState>, window: WebviewWindow, dir: String) -> Result<Vec<Moved>, String> {
    let dir = Dir::parse(&dir).ok_or("direction must be left, right, up or down")?;
    let monitors = app.available_monitors().map_err(err)?;
    let name_of = |w: &WebviewWindow| w.current_monitor().ok().flatten().and_then(|m| m.name().cloned());
    let here = name_of(&window).ok_or("cannot tell which display this wall is on")?;
    let from = monitors.iter().position(|m| m.name() == Some(&here)).ok_or("this display is no longer listed")?;
    let screens: Vec<Screen> = monitors
        .iter()
        .map(|m| Screen { x: m.position().x, y: m.position().y, w: m.size().width, h: m.size().height })
        .collect();
    let to = neighbor(&screens, from, dir).ok_or("No display on that side.")?;
    let target = &monitors[to];
    let there = target.name().cloned().unwrap_or_default();
    // another wall on the target display, if any (only wall windows: the setup
    // window is hidden while they run)
    let other = app
        .webview_windows()
        .into_iter()
        .find(|(label, w)| label.starts_with(PREFIX) && label != window.label() && name_of(w).as_deref() == Some(there.as_str()))
        .map(|(_, w)| w);
    place(&window, target).map_err(err)?;
    let mut moved = vec![Moved { label: window.label().to_string(), monitor: there.clone() }];
    if let Some(o) = &other {
        place(o, &monitors[from]).map_err(err)?;
        moved.push(Moved { label: o.label().to_string(), monitor: here.clone() });
    }
    if window.label().starts_with(PREFIX) {
        swap_wall_layouts(&state, &here, &there)?;
        // the saved session is keyed by display as well; a resume must put
        // each wall where it is now
        state.sessions.swap_last(&here, &there)?;
    }
    let _ = window.set_focus();
    // to everyone, with the label: a JS listen() hears events emitted to any
    // target, so emit_to(label) alone would reach the other walls too
    for m in &moved {
        let _ = app.emit("wall-moved", m);
    }
    Ok(moved)
}

/// The pointer moved onto a wall that does not have focus: keys should go to
/// the wall under the pointer. Focus is taken only from another window of
/// this app. When another program is in front, the walls stay behind it;
/// `set_focus` would force this window to the foreground over it.
#[tauri::command]
pub fn focus_wall(app: AppHandle, window: WebviewWindow) -> bool {
    let ours = app.webview_windows().into_iter().any(|(label, w)| label != window.label() && w.is_focused().unwrap_or(false));
    ours && window.set_focus().is_ok()
}

/// Esc on any wall: close them all. The last one to go brings setup back.
/// `close` asks first: each wall's page saves its session snapshot when asked
/// (onCloseRequested in Wall.svelte) and then closes itself. A page that does
/// not answer in time (hung) is closed without it.
#[tauri::command]
pub fn close_walls(app: AppHandle) {
    let mut asked = Vec::new();
    for (label, w) in app.webview_windows() {
        if label.starts_with(PREFIX) {
            let _ = w.close();
            asked.push(label);
        }
    }
    // only these windows: labels are never reused, and walls started again
    // from setup in the meantime are new ones
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(4000));
        for label in asked {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.destroy();
            }
        }
    });
}

/// Called for every window event (lib.rs). A wall closing with Alt+F4 also
/// lands here, so setup returns whichever way the walls went.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Destroyed) || !window.label().starts_with(PREFIX) {
        return;
    }
    let app = window.app_handle();
    let left = app.webview_windows().keys().filter(|l| l.starts_with(PREFIX) && l.as_str() != window.label()).count();
    if left > 0 {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    let _ = app.emit_to("main", "walls-closed", ());
}
