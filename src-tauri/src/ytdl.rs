//! Links (YouTube and any other page yt-dlp understands) for Stack mode:
//! downloaded once with yt-dlp into `<cache>/links`, then played from disk
//! like any file. A page URL cannot go straight into a <video>: most sites
//! serve video and audio as separate streams that need yt-dlp to pick and
//! ffmpeg to join, and their stream URLs need request headers a <video>
//! cannot send.
//!
//! `fetch_link` returns the file at once when that link was downloaded
//! before; otherwise it starts the download (unless one for the same link is
//! running) and returns None. Progress, the finished path and errors arrive
//! as `link` events, so a wall and the setup window can both follow one
//! download. links.json remembers which link made which file.

use crate::commands::AppState;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct Links {
    dir: PathBuf,
    index_path: PathBuf,
    /// link -> file it was saved as
    index: Mutex<HashMap<String, String>>,
    running: Mutex<HashSet<String>>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkEvent {
    url: String,
    /// "progress", "done" or "error"
    kind: &'static str,
    /// which download of this link (video, then audio): 1, 2, ...
    part: u32,
    downloaded: Option<f64>,
    total: Option<f64>,
    speed: Option<f64>,
    path: Option<String>,
    error: Option<String>,
}

impl Links {
    pub fn new(cache_dir: &Path) -> Self {
        let dir = cache_dir.join("links");
        let _ = fs::create_dir_all(&dir);
        let index_path = cache_dir.join("links.json");
        let index = fs::read(&index_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Links { dir, index_path, index: Mutex::new(index), running: Mutex::new(HashSet::new()) }
    }

    fn cached(&self, url: &str) -> Option<String> {
        let index = self.index.lock().ok()?;
        index.get(url).filter(|p| Path::new(p).is_file()).cloned()
    }

    fn remember(&self, url: &str, path: &str) {
        if let Ok(mut index) = self.index.lock() {
            index.insert(url.to_string(), path.to_string());
            if let Ok(bytes) = serde_json::to_vec_pretty(&*index) {
                let _ = fs::write(&self.index_path, bytes);
            }
        }
    }
}

/// a console program with no console window flashing up
fn quiet(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

fn has_ffmpeg() -> bool {
    quiet("ffmpeg").arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

fn num(s: &str) -> Option<f64> {
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// The yt-dlp arguments. `height`: the largest video height worth fetching
/// (the panes are smaller than the screen, so 4K is rarely needed). H.264 is
/// preferred because it is the cheapest to decode; HEVC is left out because
/// WebView2 plays it only with the HEVC extension installed.
fn args(url: &str, dir: &Path, height: u32, cookies: &str, merge: bool) -> Vec<String> {
    let format = if merge {
        "bv*[vcodec!^=hev][vcodec!^=hvc][vcodec!^=dvh]+ba/b[vcodec!^=hev][vcodec!^=hvc]/b"
    } else {
        // no ffmpeg: one file that already has both
        "b[vcodec!^=hev][vcodec!^=hvc]/b"
    };
    let mut a: Vec<String> = [
        "--no-playlist",
        "--newline",
        "--progress",
        "--no-mtime",
        "--encoding",
        "utf-8",
        "-f",
        format,
        "-S",
        &format!("res:{height},vcodec:h264,acodec:aac"),
        "--merge-output-format",
        "mp4/webm/mkv",
        "-P",
        &dir.to_string_lossy(),
        "-o",
        "%(extractor_key)s-%(id)s.%(ext)s",
        "--print",
        "after_move:filepath",
        "--progress-template",
        "download:CWP %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if !cookies.is_empty() {
        a.push("--cookies-from-browser".into());
        a.push(cookies.into());
    }
    a.push(url.into());
    a
}

fn download(app: &AppHandle, url: &str, height: u32, cookies: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    let dir = state.links.dir.clone();
    let mut child = quiet("yt-dlp")
        .args(args(url, &dir, height, cookies, has_ffmpeg()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "yt-dlp was not found on PATH. Install it (winget install yt-dlp, scoop install yt-dlp or pip install yt-dlp) and try again.".to_string()
            } else {
                format!("could not start yt-dlp: {e}")
            }
        })?;
    let lines: Arc<Mutex<(Vec<String>, Vec<String>)>> = Arc::default();
    let mut readers = Vec::new();
    for (stream, is_err) in [
        (child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), false),
        (child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), true),
    ] {
        let Some(stream) = stream else { continue };
        let app = app.clone();
        let url = url.to_string();
        let lines = lines.clone();
        readers.push(std::thread::spawn(move || {
            let mut part = 0u32;
            let mut last = -1.0f64;
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if let Some(rest) = line.strip_prefix("CWP ") {
                    let f: Vec<&str> = rest.split_whitespace().collect();
                    let downloaded = f.first().and_then(|s| num(s));
                    // a new download (the audio after the video) starts again from 0
                    if let Some(d) = downloaded {
                        if d < last || part == 0 {
                            part += 1;
                        }
                        last = d;
                    }
                    let total = f.get(1).and_then(|s| num(s)).or_else(|| f.get(2).and_then(|s| num(s)));
                    let _ = app.emit("link", LinkEvent { url: url.clone(), kind: "progress", part: part.max(1), downloaded, total, speed: f.get(3).and_then(|s| num(s)), ..Default::default() });
                } else if !line.is_empty() {
                    if let Ok(mut l) = lines.lock() {
                        if is_err { l.1.push(line) } else { l.0.push(line) }
                    }
                }
            }
        }));
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    for r in readers {
        let _ = r.join();
    }
    let (out, err) = lines.lock().map(|l| l.clone()).unwrap_or_default();
    if !status.success() {
        let msg = err.iter().rev().find(|l| l.starts_with("ERROR")).or(err.last()).cloned().unwrap_or_else(|| format!("yt-dlp exited with {status}"));
        return Err(msg.trim_start_matches("ERROR: ").to_string());
    }
    out.iter().rev().find(|l| Path::new(l).is_file()).cloned().ok_or_else(|| "yt-dlp finished but did not say where the file is".to_string())
}

/// The file for `url`, if it was downloaded before; else None, and the
/// download runs in the background (`link` events).
#[tauri::command]
pub fn fetch_link(app: AppHandle, state: State<'_, AppState>, url: String, height: u32, cookies: String) -> Result<Option<String>, String> {
    if let Some(p) = state.links.cached(&url) {
        return Ok(Some(p));
    }
    {
        let mut running = state.links.running.lock().map_err(|e| e.to_string())?;
        if !running.insert(url.clone()) {
            return Ok(None);
        }
    }
    let height = height.clamp(360, 4320);
    std::thread::spawn(move || {
        let result = download(&app, &url, height, &cookies);
        let state = app.state::<AppState>();
        if let Ok(mut r) = state.links.running.lock() {
            r.remove(&url);
        }
        let event = match result {
            Ok(path) => {
                state.links.remember(&url, &path);
                LinkEvent { url, kind: "done", part: 0, path: Some(path), ..Default::default() }
            }
            Err(e) => LinkEvent { url, kind: "error", part: 0, error: Some(e), ..Default::default() },
        };
        let _ = app.emit("link", event);
    });
    Ok(None)
}

/// where downloaded links are kept, for "Show in Explorer"
#[tauri::command]
pub fn links_dir(state: State<'_, AppState>) -> String {
    state.links.dir.to_string_lossy().into_owned()
}

/// What `resolve_link` found: the stream URLs to play straight from the
/// site, without downloading. `audio` is set when the site serves sound as
/// a separate stream (YouTube above 360p); a <video> plays `video` and an
/// <audio> beside it plays `audio`, kept in step.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    video: String,
    audio: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    duration: Option<f64>,
    title: String,
    live: bool,
}

/// Ask yt-dlp for a link's stream URLs (no download). Stream URLs expire
/// after some hours; resolving again gives fresh ones.
#[tauri::command]
pub async fn resolve_link(url: String, height: u32, cookies: String) -> Result<Resolved, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let height = height.clamp(360, 4320);
        let mut cmd = quiet("yt-dlp");
        cmd.args([
            "--no-playlist",
            "--no-warnings",
            "--encoding",
            "utf-8",
            "-j",
            // one stream the webview can decode on its own, or a video stream
            // and an audio stream; no HEVC (it needs the HEVC extension)
            "-f",
            "bv*[vcodec!^=hev][vcodec!^=hvc][vcodec!^=dvh][protocol^=http]+ba[protocol^=http]/b[vcodec!^=hev][vcodec!^=hvc]/b",
            "-S",
            &format!("res:{height},vcodec:h264,acodec:aac"),
        ]);
        if !cookies.is_empty() {
            cmd.args(["--cookies-from-browser", &cookies]);
        }
        let out = cmd.arg(&url).stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "yt-dlp was not found on PATH. Install it (winget install yt-dlp, scoop install yt-dlp or pip install yt-dlp) and try again.".to_string()
            } else {
                format!("could not start yt-dlp: {e}")
            }
        })?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let line = err.lines().rev().find(|l| l.starts_with("ERROR")).or(err.lines().last()).unwrap_or("yt-dlp failed");
            return Err(line.trim_start_matches("ERROR: ").to_string());
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let j: serde_json::Value = serde_json::from_str(text.lines().last().unwrap_or("")).map_err(|e| format!("yt-dlp gave no readable answer: {e}"))?;
        let f = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_f64());
        let s = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        let parts = j.get("requested_formats").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        let has_video = |p: &serde_json::Value| p.get("vcodec").and_then(|x| x.as_str()).is_some_and(|c| c != "none");
        let (video, audio, width, height) = if parts.len() >= 2 {
            let v = parts.iter().find(|p| has_video(p)).unwrap_or(&parts[0]);
            let a = parts.iter().find(|p| !has_video(p));
            (s(v, "url"), a.and_then(|a| s(a, "url")), f(v, "width"), f(v, "height"))
        } else {
            (s(&j, "url"), None, f(&j, "width"), f(&j, "height"))
        };
        Ok(Resolved {
            video: video.ok_or("yt-dlp found no stream to play")?,
            audio,
            width,
            height,
            duration: f(&j, "duration"),
            title: s(&j, "title").unwrap_or_default(),
            live: j.get("is_live").and_then(|x| x.as_bool()).unwrap_or(false),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
