//! Several walls at once: one fullscreen window per display, each running
//! its own wall (the frontend reads which display from `window.__CW_WALL__`).
//! The setup window hides while they run and comes back when the last one
//! closes, however it was closed.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::utils::config::WindowConfig;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, Window, WindowEvent};

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

/// Open a wall on each named display, then hide the setup window. Returns how
/// many opened; displays that are no longer connected are skipped.
// async: creating a window from a synchronous command deadlocks on Windows
#[tauri::command]
pub async fn open_walls(app: AppHandle, template: State<'_, Template>, monitors: Vec<String>) -> Result<usize, String> {
    let all = app.available_monitors().map_err(err)?;
    let cursor = app.cursor_position().ok();
    let mut focus = None;
    let mut opened = 0;
    for name in &monitors {
        let Some(m) = all.iter().find(|m| m.name().is_some_and(|n| n == name)) else {
            continue;
        };
        let mut cfg = template.config.clone();
        cfg.label = format!("{PREFIX}{}", NEXT.fetch_add(1, Ordering::Relaxed));
        cfg.visible = false;
        cfg.center = false;
        cfg.decorations = false;
        // small enough to sit inside any display before going fullscreen, so
        // Windows fullscreens it on the one it was moved to
        cfg.width = 640.0;
        cfg.height = 400.0;
        cfg.min_width = None;
        cfg.min_height = None;
        let mut builder = tauri::WebviewWindowBuilder::from_config(&app, &cfg)
            .map_err(err)?
            .initialization_script(format!("window.__CW_WALL__ = {};", serde_json::to_string(name).map_err(err)?));
        if let Some(dir) = &template.data_dir {
            builder = builder.data_directory(dir.clone());
        }
        let w = builder.build().map_err(err)?;
        let (pos, size) = (m.position(), m.size());
        w.set_position(PhysicalPosition::new(pos.x + 60, pos.y + 60)).map_err(err)?;
        w.set_fullscreen(true).map_err(err)?;
        w.show().map_err(err)?;
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

/// Esc on any wall: close them all. The last one to go brings setup back.
#[tauri::command]
pub fn close_walls(app: AppHandle) {
    for (label, w) in app.webview_windows() {
        if label.starts_with(PREFIX) {
            let _ = w.close();
        }
    }
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
