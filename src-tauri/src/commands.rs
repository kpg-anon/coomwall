//! The IPC surface. Every command is a thin wrapper over `coomwall_engine`;
//! the solver commands are pure functions of their arguments, so the frontend
//! owns the wall's state and Rust holds only the dimension cache.

use crate::gpu::{self, GpuInfo};
use coomwall_engine::cache::{DimCache, DimRecord};
use coomwall_engine::layout::{self, Params, Placed, Plan, Rect, Tree};
use coomwall_engine::scan::{self, ScanReport};
use serde::Deserialize;
use std::collections::HashMap;
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
    /// resolved once at launch; the webview's browser args were built from it
    pub gpu: GpuInfo,
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
        let saved = read_settings(&settings_path);
        let text = |key: &str, default: &str| saved.get(key).and_then(|v| v.as_str()).unwrap_or(default).to_string();
        let gpu = gpu::resolve(&text("gpu", "auto"));
        Ok(AppState {
            cache: Arc::new(Mutex::new(DimCache::load(&cache_path))),
            cache_path,
            settings_path,
            settings_lock: Mutex::new(()),
            gpu,
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
    tauri::async_runtime::spawn_blocking(move || {
        let cache = cache.lock().map_err(err)?;
        Ok(scan::scan(&sources, recursive, &cache))
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

/// The same tree on a new screen size (window resize, other monitor).
#[tauri::command]
pub fn plan_layout(tree: Tree, bounds: Rect) -> Vec<Placed> {
    layout::layout(&tree, bounds).into_iter().map(|(id, rect)| Placed { id, rect }).collect()
}

/// Settings are opaque JSON to Rust: the frontend owns their shape and fills
/// in defaults for anything missing.
fn read_settings(path: &PathBuf) -> serde_json::Value {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(serde_json::Value::Null)
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

#[tauri::command]
pub fn gpu_info(state: State<'_, AppState>) -> GpuInfo {
    state.gpu.clone()
}

/// Relaunch, so a changed GPU setting reaches the webview's browser args.
#[tauri::command]
pub fn restart(app: AppHandle) {
    app.restart()
}
