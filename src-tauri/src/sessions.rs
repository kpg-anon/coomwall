//! Saved walls, to resume later: `last`, which every running wall writes into
//! every 10 s and as it closes, and named saves (Ctrl+S on a wall). Stored as
//! sessions.json beside settings.json:
//!
//!     { "last": Session | null, "named": [Session, ...] }
//!     Session = { name, savedAt, run, multi, sources, recursive, walls: { monitor: snapshot } }
//!
//! A wall's snapshot is opaque to Rust (the frontend owns its shape) except
//! for `mode`, `count` and `monitor`, which the setup screen lists. Several
//! wall windows write at once, so every write is a merge made here under one
//! lock. `run` tells one start of the walls (or one Ctrl+S) from the next: the
//! first snapshot written with a new `run` replaces the slot, the ones after
//! it with the same `run` join it. So a fresh start replaces `last` only once
//! its wall has something to save.

use crate::commands::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

/// named saves kept; saving one more drops the oldest
const MAX_NAMED: usize = 200;

pub struct Sessions {
    path: PathBuf,
    lock: Mutex<()>,
    /// snapshots the walls about to open take once, by monitor ("" = the single wall)
    pending: Mutex<HashMap<String, Value>>,
}

/// What every wall of a session shares.
#[derive(Deserialize)]
pub struct Header {
    multi: bool,
    sources: Vec<String>,
    recursive: bool,
}

/// One wall of a session, for the setup screen's list: what it played and a
/// drawing of its tiles (`thumb`, made by the wall; absent in older saves).
#[derive(Serialize)]
pub struct WallInfo {
    monitor: String,
    mode: String,
    count: u64,
    layout: Value,
    sources: Value,
    own: bool,
    thumb: Value,
}

/// A session as the setup screen lists it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    name: String,
    saved_at: u64,
    multi: bool,
    walls: Vec<WallInfo>,
}

#[derive(Serialize)]
pub struct List {
    last: Option<Info>,
    named: Vec<Info>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// a session as stored, or None when it is not one
fn valid(v: &Value) -> bool {
    v.get("name").is_some_and(Value::is_string) && v.get("walls").is_some_and(Value::is_object)
}

impl Sessions {
    pub fn new(path: PathBuf) -> Self {
        Sessions { path, lock: Mutex::new(()), pending: Mutex::new(HashMap::new()) }
    }

    /// The file, with anything missing or malformed read as no sessions.
    fn read(&self) -> Value {
        let v = crate::commands::read_json(&self.path);
        let last = v.get("last").filter(|l| valid(l)).cloned().unwrap_or(Value::Null);
        let named: Vec<Value> = v.get("named").and_then(Value::as_array).map(|a| a.iter().filter(|s| valid(s)).cloned().collect()).unwrap_or_default();
        json!({ "last": last, "named": named })
    }

    fn write(&self, v: &Value) -> Result<(), String> {
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(v).map_err(err)?).map_err(err)?;
        fs::rename(&tmp, &self.path).map_err(err)
    }

    /// Put one wall's snapshot into `last` (name None) or a named save.
    fn put(&self, name: Option<String>, run: u64, header: Header, monitor: String, mut wall: Value) -> Result<(), String> {
        let _turn = self.lock.lock().map_err(err)?;
        let mut file = self.read();
        let now = now_ms();
        let fresh = || json!({
            "name": name.clone().unwrap_or_else(|| "last".into()),
            "savedAt": now,
            "run": run,
            "multi": header.multi,
            "sources": header.sources,
            "recursive": header.recursive,
            "walls": {},
        });
        let slot: &mut Value = match &name {
            None => &mut file["last"],
            Some(n) => {
                let named = file["named"].as_array_mut().ok_or("sessions: named is not a list")?;
                match named.iter().position(|s| s["name"].as_str() == Some(n.as_str())) {
                    // this save is still being written by the other walls
                    Some(i) if named[i]["run"].as_u64() == Some(run) => &mut named[i],
                    // saving under an existing name replaces it; newest first
                    found => {
                        if let Some(i) = found {
                            named.remove(i);
                        }
                        named.insert(0, fresh());
                        &mut named[0]
                    }
                }
            }
        };
        // the walls of an older start, still saving as they close, must not
        // replace the session of the walls started after them
        if name.is_none() && valid(slot) && slot["run"].as_u64().is_some_and(|r| r > run) {
            return Ok(());
        }
        if slot["run"].as_u64() != Some(run) || !valid(slot) {
            *slot = fresh();
        }
        if let Some(o) = wall.as_object_mut() {
            o.insert("monitor".into(), monitor.clone().into());
        }
        // nothing changed (a paused wall of images): no write
        if name.is_none() && slot["walls"].get(monitor.as_str()) == Some(&wall) {
            return Ok(());
        }
        slot["walls"][monitor.as_str()] = wall;
        slot["savedAt"] = now.into();
        if let Some(named) = file["named"].as_array_mut() {
            named.truncate(MAX_NAMED);
        }
        self.write(&file)
    }

    /// Ctrl+Shift+arrow moved walls between displays: their snapshots in
    /// `last` follow them. A display with no snapshot leaves none behind.
    pub fn swap_last(&self, a: &str, b: &str) -> Result<(), String> {
        let _turn = self.lock.lock().map_err(err)?;
        let mut file = self.read();
        let Some(walls) = file["last"].get_mut("walls").and_then(Value::as_object_mut) else {
            return Ok(());
        };
        let (wa, wb) = (walls.remove(a), walls.remove(b));
        let mut put = |key: &str, w: Option<Value>| {
            if let Some(mut w) = w {
                if let Some(o) = w.as_object_mut() {
                    o.insert("monitor".into(), key.into());
                }
                walls.insert(key.into(), w);
            }
        };
        put(b, wa);
        put(a, wb);
        self.write(&file)
    }
}

fn info(s: &Value) -> Info {
    let walls = s["walls"]
        .as_object()
        .map(|m: &Map<String, Value>| {
            m.iter()
                .map(|(k, w)| WallInfo {
                    monitor: k.clone(),
                    mode: w["mode"].as_str().unwrap_or("").to_string(),
                    count: w["count"].as_u64().unwrap_or(0),
                    layout: w["layout"].clone(),
                    sources: w["sources"].clone(),
                    own: w["own"].as_bool().unwrap_or(false),
                    thumb: w["thumb"].clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    Info {
        name: s["name"].as_str().unwrap_or("").to_string(),
        saved_at: s["savedAt"].as_u64().unwrap_or(0),
        multi: s["multi"].as_bool().unwrap_or(false),
        walls,
    }
}

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> List {
    let file = state.sessions.read();
    List {
        last: Some(&file["last"]).filter(|l| !l.is_null()).map(info),
        named: file["named"].as_array().map(|a| a.iter().map(info).collect()).unwrap_or_default(),
    }
}

/// The whole session: `last` (name None) or a named one.
#[tauri::command]
pub fn get_session(state: State<'_, AppState>, name: Option<String>) -> Option<Value> {
    let file = state.sessions.read();
    let s = match name {
        None => file["last"].clone(),
        Some(n) => file["named"].as_array()?.iter().find(|s| s["name"].as_str() == Some(n.as_str()))?.clone(),
    };
    Some(s).filter(|s| !s.is_null())
}

#[tauri::command]
pub fn put_session_wall(state: State<'_, AppState>, name: Option<String>, run: u64, header: Header, monitor: String, wall: Value) -> Result<(), String> {
    state.sessions.put(name, run, header, monitor, wall)
}

#[tauri::command]
pub fn delete_session(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let s = &state.sessions;
    let _turn = s.lock.lock().map_err(err)?;
    let mut file = s.read();
    if let Some(named) = file["named"].as_array_mut() {
        named.retain(|x| x["name"].as_str() != Some(name.as_str()));
    }
    s.write(&file)
}

/// The walls about to open resume session `name` (None: `last`): `walls`
/// pairs a saved display with the key the wall will ask for (its display, or
/// "" for the single wall). `note` is shown on each wall as it starts.
/// Replaces anything set before; an empty list just clears it. Returns how
/// many snapshots are waiting.
#[tauri::command]
pub fn set_resume(state: State<'_, AppState>, name: Option<String>, walls: Vec<(String, String)>, note: String) -> Result<usize, String> {
    let mut pending = state.sessions.pending.lock().map_err(err)?;
    pending.clear();
    if walls.is_empty() {
        return Ok(0);
    }
    let file = state.sessions.read();
    let session = match &name {
        None => file["last"].clone(),
        Some(n) => file["named"].as_array().and_then(|a| a.iter().find(|s| s["name"].as_str() == Some(n.as_str())).cloned()).unwrap_or(Value::Null),
    };
    for (from, to) in walls {
        if let Some(mut w) = session["walls"].get(&from).cloned().filter(Value::is_object) {
            if !note.is_empty() {
                w["note"] = note.clone().into();
            }
            pending.insert(to, w);
        }
    }
    Ok(pending.len())
}

/// A wall starting: its snapshot to resume, once. A rebuild later (another
/// mode, a resize) finds nothing and starts from the queue as usual.
#[tauri::command]
pub fn take_resume(state: State<'_, AppState>, monitor: String) -> Result<Option<Value>, String> {
    Ok(state.sessions.pending.lock().map_err(err)?.remove(&monitor))
}
