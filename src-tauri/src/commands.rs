//! The IPC surface. Every command is a thin wrapper over `coomwall_engine`;
//! the solver commands are pure functions of their arguments, so the frontend
//! owns the wall's state and Rust holds only the dimension cache.

use crate::gpu::{self, GpuInfo};
use crate::sessions::Sessions;
use crate::ytdl::Links;
use coomwall_engine::cache::{DimCache, DimRecord};
use coomwall_engine::layout::{self, Params, Placed, Plan, Rect, Tree};
use coomwall_engine::scan::{self, ScanReport};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    cache: Arc<Mutex<DimCache>>,
    cache_path: PathBuf,
    settings_path: PathBuf,
    /// several windows save settings (one per wall); writes take turns
    settings_lock: Mutex<()>,
    /// files the user chose "never show again" for, as they were spelled
    hidden: Mutex<Vec<String>>,
    hidden_path: PathBuf,
    /// resolved once at launch; the webview's browser args were built from it
    pub gpu: GpuInfo,
    /// the `color` setting this launch started with: "direct" or "managed"
    pub color: String,
    /// saved walls (sessions.json beside settings.json)
    pub sessions: Sessions,
    /// links downloaded with yt-dlp (Stack mode)
    pub links: Links,
}

impl AppState {
    pub fn new(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let (config, cache_dir) = match dev_data_dir() {
            Some(dir) => (dir.join("config"), dir.join("cache")),
            None => (app.path().app_config_dir()?, app.path().app_cache_dir()?),
        };
        fs::create_dir_all(&config)?;
        fs::create_dir_all(&cache_dir)?;
        let cache_path = cache_dir.join("dims.json");
        let settings_path = config.join("settings.json");
        let hidden_path = config.join("hidden.json");
        let hidden = fs::read(&hidden_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let saved = read_settings(&settings_path);
        let text = |key: &str, default: &str| saved.get(key).and_then(|v| v.as_str()).unwrap_or(default).to_string();
        let gpu = gpu::resolve(&text("gpu", "auto"));
        let color = if text("color", "direct") == "managed" { "managed" } else { "direct" }.to_string();
        Ok(AppState {
            cache: Arc::new(Mutex::new(DimCache::load(&cache_path))),
            cache_path,
            settings_path,
            settings_lock: Mutex::new(()),
            hidden: Mutex::new(hidden),
            hidden_path,
            gpu,
            color,
            sessions: Sessions::new(config.join("sessions.json")),
            links: Links::new(&cache_dir),
        })
    }
}

/// dev only: CW_DATA_DIR keeps settings, the dimension cache and the WebView2
/// profile under one folder, so test runs never touch the installed app's data
pub fn dev_data_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Ok(dir) = std::env::var("CW_DATA_DIR") {
        if !dir.is_empty() {
            return Some(std::path::absolute(dir).ok()?);
        }
    }
    None
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn scan_sources(state: State<'_, AppState>, sources: Vec<String>, recursive: bool) -> Result<ScanReport, String> {
    let cache = state.cache.clone();
    let hidden: HashSet<String> = state.hidden.lock().map_err(err)?.iter().map(|p| scan::path_key(p)).collect();
    tauri::async_runtime::spawn_blocking(move || {
        // a copy: a walk of a large network folder takes a while, and the
        // walls' remember_dims must not wait for it
        let cache = cache.lock().map_err(err)?.clone();
        Ok(scan::scan(&sources, recursive, &cache).without(&hidden))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn remember_dims(state: State<'_, AppState>, records: Vec<DimRecord>) -> Result<usize, String> {
    let cache = state.cache.clone();
    let path = state.cache_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = cache.lock().map_err(err)?;
        let changed = cache.merge(records);
        if changed > 0 {
            cache.save(&path).map_err(err)?;
        }
        Ok(changed)
    })
    .await
    .map_err(err)?
}

#[derive(Deserialize)]
pub struct Item {
    id: u32,
    aspect: f64,
}

#[tauri::command]
pub async fn plan_initial(items: Vec<Item>, bounds: Rect, params: Params) -> Result<Option<Plan>, String> {
    let items: Vec<(u32, f64)> = items.into_iter().map(|i| (i.id, i.aspect)).collect();
    Ok(layout::arrange(&items, bounds, &HashMap::new(), &params))
}

#[tauri::command]
pub async fn plan_replace(
    tree: Tree,
    bounds: Rect,
    leaf: u32,
    media: HashMap<u32, f64>,
    candidates: Vec<f64>,
    params: Params,
) -> Result<Option<Plan>, String> {
    Ok(layout::replace(&tree, bounds, leaf, &media, &candidates, &params))
}

#[tauri::command]
pub async fn plan_insert(
    tree: Option<Tree>,
    bounds: Rect,
    new_id: u32,
    aspect: f64,
    media: HashMap<u32, f64>,
    params: Params,
) -> Result<Option<Plan>, String> {
    Ok(layout::insert(tree.as_ref(), bounds, new_id, aspect, &media, &params))
}

#[tauri::command]
pub async fn plan_remove(
    tree: Tree,
    bounds: Rect,
    leaf: Option<u32>,
    media: HashMap<u32, f64>,
    params: Params,
) -> Result<Option<Plan>, String> {
    Ok(layout::remove(&tree, bounds, leaf, &media, &params))
}

#[tauri::command]
pub async fn plan_retile(tree: Tree, bounds: Rect, media: HashMap<u32, f64>, params: Params) -> Result<Option<Plan>, String> {
    Ok(layout::retile(&tree, bounds, &media, &params))
}

#[tauri::command]
pub async fn plan_reflow(
    tree: Tree,
    bounds: Rect,
    leaf: u32,
    aspect: f64,
    media: HashMap<u32, f64>,
    params: Params,
) -> Result<Option<Plan>, String> {
    Ok(layout::reflow(&tree, bounds, leaf, aspect, &media, &params))
}

/// An item in the centre (Mosaic, Dynamic): `center` in the middle of the
/// wall, `items` around it. `prev` holds the rectangles of tiles already on
/// screen, so a re-layout keeps them near where they are. `at` holds the
/// centre where it is (Dynamic's changes).
#[tauri::command]
pub async fn plan_center(
    center: Item,
    share: f64,
    items: Vec<Item>,
    bounds: Rect,
    prev: Option<HashMap<u32, Rect>>,
    params: Params,
    at: Option<Rect>,
) -> Result<Option<Plan>, String> {
    let items: Vec<(u32, f64)> = items.into_iter().map(|i| (i.id, i.aspect)).collect();
    Ok(layout::arrange_center_at((center.id, center.aspect), share, at, &items, bounds, &prev.unwrap_or_default(), &params))
}

/// The same tree on a new screen size (window resize, other monitor).
#[tauri::command]
pub fn plan_layout(tree: Tree, bounds: Rect) -> Vec<Placed> {
    layout::layout(&tree, bounds).into_iter().map(|(id, rect)| Placed { id, rect }).collect()
}

/// Settings are opaque JSON to Rust: the frontend owns their shape and fills
/// in defaults for anything missing.
/// A JSON file, or Null when it does not exist. A file that does not parse
/// is renamed to `<name>.bad-<time>.json` first: the next save would
/// otherwise replace it and lose everything in it (every saved wall, say).
pub fn read_json(path: &std::path::Path) -> serde_json::Value {
    let Ok(bytes) = fs::read(path) else {
        return serde_json::Value::Null;
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let keep = path.with_file_name(format!("{stem}.bad-{stamp}.json"));
            eprintln!("coomwall: {} could not be read ({e}); kept as {}", path.display(), keep.display());
            let _ = fs::rename(path, &keep);
            serde_json::Value::Null
        }
    }
}

fn read_settings(path: &PathBuf) -> serde_json::Value {
    read_json(path)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> serde_json::Value {
    read_settings(&state.settings_path)
}

fn write_settings(path: &PathBuf, value: &serde_json::Value) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value).map_err(err)?).map_err(err)?;
    fs::rename(&tmp, path).map_err(err)
}

#[tauri::command]
pub fn set_settings(state: State<'_, AppState>, value: serde_json::Value) -> Result<(), String> {
    let _turn = state.settings_lock.lock().map_err(err)?;
    write_settings(&state.settings_path, &value)
}

/// Merge part of the settings into the file (a wall window saving its own
/// layout) without touching anything another window wrote.
#[tauri::command]
pub fn patch_settings(state: State<'_, AppState>, patch: serde_json::Value) -> Result<(), String> {
    let _turn = state.settings_lock.lock().map_err(err)?;
    let mut value = read_settings(&state.settings_path);
    coomwall_engine::patch::merge(&mut value, patch);
    write_settings(&state.settings_path, &value)
}

/// Swap two displays' entries under `walls` in settings.json: a wall moved
/// with Ctrl+Shift+arrow takes its layout with it. A display without an
/// entry gets the other's layout turned off.
pub fn swap_wall_layouts(state: &AppState, a: &str, b: &str) -> Result<(), String> {
    let _turn = state.settings_lock.lock().map_err(err)?;
    let mut value = read_settings(&state.settings_path);
    let Some(walls) = value.get_mut("walls").and_then(|w| w.as_object_mut()) else {
        return Ok(());
    };
    let off = |mut l: serde_json::Value| {
        l["on"] = false.into();
        l
    };
    match (walls.remove(a), walls.remove(b)) {
        (Some(la), Some(lb)) => {
            walls.insert(b.into(), la);
            walls.insert(a.into(), lb);
        }
        (Some(la), None) => {
            walls.insert(b.into(), la.clone());
            walls.insert(a.into(), off(la));
        }
        (None, Some(lb)) => {
            walls.insert(a.into(), lb.clone());
            walls.insert(b.into(), off(lb));
        }
        (None, None) => {}
    }
    write_settings(&state.settings_path, &value)
}

fn save_hidden(state: &AppState, list: &[String]) -> Result<(), String> {
    let tmp = state.hidden_path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(list).map_err(err)?).map_err(err)?;
    fs::rename(&tmp, &state.hidden_path).map_err(err)
}

#[tauri::command]
pub fn get_hidden(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.hidden.lock().map_err(err)?.clone())
}

/// "Never show again": later scans leave the file out.
#[tauri::command]
pub fn hide_item(state: State<'_, AppState>, path: String) -> Result<usize, String> {
    let mut list = state.hidden.lock().map_err(err)?;
    let key = scan::path_key(&path);
    if !list.iter().any(|p| scan::path_key(p) == key) {
        list.push(path);
        save_hidden(&state, &list)?;
    }
    Ok(list.len())
}

#[tauri::command]
pub fn unhide_items(state: State<'_, AppState>, paths: Vec<String>) -> Result<usize, String> {
    let mut list = state.hidden.lock().map_err(err)?;
    let drop: HashSet<String> = paths.iter().map(|p| scan::path_key(p)).collect();
    list.retain(|p| !drop.contains(&scan::path_key(p)));
    save_hidden(&state, &list)?;
    Ok(list.len())
}

#[tauri::command]
pub fn gpu_info(state: State<'_, AppState>) -> GpuInfo {
    state.gpu.clone()
}

/// The colour setting this launch started with. A change needs a restart,
/// like the GPU setting: both are browser arguments.
#[tauri::command]
pub fn launch_color(state: State<'_, AppState>) -> String {
    state.color.clone()
}

/// Relaunch, so a changed GPU or colour setting reaches the webview's browser args.
#[tauri::command]
pub fn restart(app: AppHandle) {
    app.restart()
}

const MEDIA_EXTS: &[&str] = &["mp4", "m4v", "webm", "mov", "mkv", "ogv", "jpg", "jpeg", "jfif", "png", "webp", "gif", "avif", "bmp"];

/// "Open in default app": a media file or an http(s) link only. The page has
/// no permission to open paths itself, so nothing it is tricked into asking
/// for (a .bat, an .exe) can be run.
#[tauri::command]
pub fn open_media(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let lower = path.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return app.opener().open_url(path, None::<&str>).map_err(err);
    }
    let ext = std::path::Path::new(&path).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if !MEDIA_EXTS.contains(&ext.as_str()) {
        return Err("only media files are opened from the wall".into());
    }
    app.opener().open_path(path, None::<&str>).map_err(err)
}

/// Open the folder where links downloaded with yt-dlp are kept.
#[tauri::command]
pub fn open_links_dir(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = crate::ytdl::links_dir(state);
    app.opener().open_path(dir, None::<&str>).map_err(err)
}
