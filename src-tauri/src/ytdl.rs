//! Links (YouTube and any other page yt-dlp understands) for Stack mode.
//!
//! Two ways to play one:
//! - `resolve_link`: yt-dlp finds the stream URLs and the page plays them
//!   straight from the site (a video stream, and a separate audio stream that
//!   the page keeps in step). Nothing is saved.
//! - `fetch_link`: yt-dlp downloads it once into `<cache>/links` (ffmpeg joins
//!   video and audio), and it plays from disk like any file. Returns the file
//!   at once when that link was downloaded before at least as tall as asked;
//!   otherwise starts the download (unless one is running) and returns None.
//!   Stages, progress, the finished path and errors arrive as `link` events,
//!   so a wall and the setup window can both follow one download.
//!
//! Every yt-dlp process goes into one Windows job object that is closed when
//! the app exits, so yt-dlp and the ffmpeg it starts never outlive coomwall.
//! yt-dlp runs with `--ignore-config`: the user's own yt-dlp config (audio
//! only, archives, output templates) must not change what coomwall gets.

use crate::commands::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// a download with no output for this long is stopped
const IDLE_LIMIT: Duration = Duration::from_secs(600);
/// finding a link's streams takes a few seconds; this long means it hung
const RESOLVE_LIMIT: Duration = Duration::from_secs(90);

#[derive(Serialize, Deserialize, Clone)]
struct Cached {
    path: String,
    /// the height asked for when it was downloaded (0: unknown)
    #[serde(default)]
    height: u32,
}

pub struct Links {
    dir: PathBuf,
    index_path: PathBuf,
    /// link -> the file it was saved as
    index: Mutex<HashMap<String, Cached>>,
    /// links being downloaded, with a flag that cancels each
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkEvent {
    url: String,
    /// "stage", "progress", "done" or "error"
    kind: &'static str,
    /// "stage": what yt-dlp is doing, in words
    stage: Option<String>,
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
        // what an interrupted download left behind
        if let Ok(entries) = fs::read_dir(&dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                if name.ends_with(".part") || name.ends_with(".ytdl") || name.contains(".part-frag") || name.contains(".temp.") {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
        let index_path = cache_dir.join("links.json");
        let raw: HashMap<String, serde_json::Value> = fs::read(&index_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        // older entries were just the path
        let index = raw
            .into_iter()
            .filter_map(|(k, v)| match v {
                serde_json::Value::String(path) => Some((k, Cached { path, height: 0 })),
                v => serde_json::from_value(v).ok().map(|c| (k, c)),
            })
            .collect();
        Links { dir, index_path, index: Mutex::new(index), running: Mutex::new(HashMap::new()) }
    }

    /// the file for `url`, if it is on disk and was fetched at least `height` tall
    fn cached(&self, url: &str, height: u32) -> Option<String> {
        let index = self.index.lock().ok()?;
        index.get(url).filter(|c| Path::new(&c.path).is_file() && (c.height == 0 || c.height >= height)).map(|c| c.path.clone())
    }

    fn remember(&self, url: &str, path: &str, height: u32) {
        let Ok(mut index) = self.index.lock() else { return };
        index.insert(url.to_string(), Cached { path: path.to_string(), height });
        if let Ok(bytes) = serde_json::to_vec_pretty(&*index) {
            // a crash mid-write must not lose the whole index
            let tmp = self.index_path.with_extension("json.tmp");
            if fs::write(&tmp, bytes).is_ok() {
                let _ = fs::rename(&tmp, &self.index_path);
            }
        }
    }
}

/// Only http(s) links reach yt-dlp, so nothing from the page is read as an option.
fn check_url(url: &str) -> Result<(), String> {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    if (lower.starts_with("https://") || lower.starts_with("http://")) && !u.chars().any(char::is_whitespace) {
        Ok(())
    } else {
        Err("not a web link (it has to start with http:// or https://)".into())
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

#[cfg(windows)]
mod job {
    //! One job object for every yt-dlp, set to kill its processes when the
    //! last handle closes, which is when coomwall exits. Processes yt-dlp
    //! starts (ffmpeg, the scoop shim's target) are in the job too.
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    fn job() -> Option<&'static Job> {
        static JOB: OnceLock<Option<Job>> = OnceLock::new();
        JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(None, None).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32).ok()?;
            Some(Job(h))
        })
        .as_ref()
    }

    pub fn adopt(child: &std::process::Child) {
        if let Some(j) = job() {
            unsafe {
                let _ = AssignProcessToJobObject(j.0, HANDLE(child.as_raw_handle()));
            }
        }
    }
}

#[cfg(not(windows))]
mod job {
    pub fn adopt(_: &std::process::Child) {}
}

fn spawn(args: &[String]) -> Result<Child, String> {
    let child = quiet("yt-dlp").args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "yt-dlp was not found on PATH. Install it (winget install yt-dlp, scoop install yt-dlp or pip install yt-dlp) and try again.".to_string()
        } else {
            format!("could not start yt-dlp: {e}")
        }
    })?;
    job::adopt(&child);
    Ok(child)
}

/// Read a pipe line by line, whatever its encoding: a line that is not
/// UTF-8 must not stop the reading, or the pipe fills and yt-dlp blocks.
fn each_line(stream: impl Read, mut f: impl FnMut(String)) {
    let mut r = BufReader::new(stream);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => f(String::from_utf8_lossy(&buf).trim().to_string()),
        }
    }
}

fn version(program: &str, arg: &str) -> Option<String> {
    let out = quiet(program).arg(arg).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.trim().to_string())
}

fn has_ffmpeg() -> bool {
    version("ffmpeg", "-version").is_some()
}

fn num(s: &str) -> Option<f64> {
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// The yt-dlp arguments for a download. `height`: the largest video height
/// worth fetching (yt-dlp's `res` is a video's smaller side). H.264 first, as
/// the cheapest to decode; no HEVC, which WebView2 plays only with the HEVC
/// extension installed.
fn download_args(url: &str, dir: &Path, height: u32, cookies: &str, merge: bool) -> Vec<String> {
    let format = if merge {
        "bv*[vcodec!^=hev][vcodec!^=hvc][vcodec!^=dvh]+ba/b[vcodec!^=hev][vcodec!^=hvc]/b"
    } else {
        // no ffmpeg: one file that already has both
        "b[vcodec!^=hev][vcodec!^=hvc]/b"
    };
    let mut a: Vec<String> = vec![
        "--ignore-config".into(),
        "--no-playlist".into(),
        "--newline".into(),
        "--progress".into(),
        "--no-mtime".into(),
        "--encoding".into(),
        "utf-8".into(),
        "-f".into(),
        format.into(),
        "-S".into(),
        format!("res:{height},vcodec:h264,acodec:aac"),
        "--merge-output-format".into(),
        "mp4/webm/mkv".into(),
        "-P".into(),
        dir.to_string_lossy().into_owned(),
        "-o".into(),
        format!("%(extractor_key)s-%(id)s-{height}.%(ext)s"),
        "--print".into(),
        "before_dl:CWS download".into(),
        "--print".into(),
        "after_move:filepath".into(),
        "--progress-template".into(),
        "download:CWP %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s".into(),
        "--progress-template".into(),
        "postprocess:CWS postprocess %(progress.postprocessor)s".into(),
    ];
    if !cookies.is_empty() {
        a.push("--cookies-from-browser".into());
        a.push(cookies.into());
    }
    a.push("--".into());
    a.push(url.into());
    a
}

fn stage(app: &AppHandle, url: &str, text: &str) {
    let _ = app.emit("link", LinkEvent { url: url.to_string(), kind: "stage", stage: Some(text.to_string()), ..Default::default() });
}

fn download(app: &AppHandle, url: &str, height: u32, cookies: &str, cancel: &AtomicBool) -> Result<String, String> {
    let state = app.state::<AppState>();
    let dir = state.links.dir.clone();
    let merge = has_ffmpeg();
    stage(app, url, if merge { "finding the video" } else { "finding the video · no ffmpeg on PATH, so one-file formats only (360p on YouTube)" });
    let mut child = spawn(&download_args(url, &dir, height, cookies, merge))?;
    let active = Arc::new(Mutex::new(Instant::now()));
    let lines: Arc<Mutex<(Vec<String>, Vec<String>)>> = Arc::default();
    let mut readers = Vec::new();
    let streams: [(Option<Box<dyn Read + Send>>, bool); 2] = [
        (child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), false),
        (child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>), true),
    ];
    for (stream, is_err) in streams {
        let Some(stream) = stream else { continue };
        let (app, url, lines, active) = (app.clone(), url.to_string(), lines.clone(), active.clone());
        readers.push(std::thread::spawn(move || {
            let mut part = 0u32;
            let mut last = -1.0f64;
            each_line(stream, |line| {
                if let Ok(mut a) = active.lock() {
                    *a = Instant::now();
                }
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
                } else if let Some(rest) = line.strip_prefix("CWS ") {
                    let text = if rest.starts_with("postprocess") {
                        if rest.contains("Merger") { "joining video and sound" } else { "finishing" }
                    } else {
                        "downloading"
                    };
                    stage(&app, &url, text);
                } else if !line.is_empty() {
                    if let Ok(mut l) = lines.lock() {
                        if is_err { l.1.push(line) } else { l.0.push(line) }
                    }
                }
            });
        }));
    }
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        let idle = active.lock().map(|a| a.elapsed()).unwrap_or_default();
        if cancel.load(Ordering::Relaxed) || idle > IDLE_LIMIT {
            let _ = child.kill();
            let _ = child.wait();
            for r in readers {
                let _ = r.join();
            }
            return Err(if idle > IDLE_LIMIT { "yt-dlp stopped answering for 10 minutes; the download was stopped".into() } else { "cancelled".into() });
        }
        std::thread::sleep(Duration::from_millis(250));
    };
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

/// The file for `url`, if it was downloaded before at least `height` tall;
/// else None, and the download runs in the background (`link` events).
#[tauri::command]
pub fn fetch_link(app: AppHandle, state: State<'_, AppState>, url: String, height: u32, cookies: String) -> Result<Option<String>, String> {
    check_url(&url)?;
    let height = height.clamp(360, 4320);
    if let Some(p) = state.links.cached(&url, height) {
        return Ok(Some(p));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = state.links.running.lock().map_err(|e| e.to_string())?;
        if running.contains_key(&url) {
            return Ok(None);
        }
        running.insert(url.clone(), cancel.clone());
    }
    std::thread::spawn(move || {
        // a panic inside must still free the link and say so
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| download(&app, &url, height, &cookies, &cancel)))
            .unwrap_or_else(|_| Err("the download failed inside coomwall".into()));
        let state = app.state::<AppState>();
        // remembered before it leaves `running`, so no second download starts in between
        if let Ok(path) = &result {
            state.links.remember(&url, path, height);
        }
        if let Ok(mut r) = state.links.running.lock() {
            r.remove(&url);
        }
        let event = match result {
            Ok(path) => LinkEvent { url, kind: "done", path: Some(path), ..Default::default() },
            Err(e) => LinkEvent { url, kind: "error", error: Some(e), ..Default::default() },
        };
        let _ = app.emit("link", event);
    });
    Ok(None)
}

/// Stop a running download of `url`.
#[tauri::command]
pub fn cancel_link(state: State<'_, AppState>, url: String) {
    if let Ok(r) = state.links.running.lock() {
        if let Some(flag) = r.get(&url) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// where downloaded links are kept, for "Show in Explorer"
#[tauri::command]
pub fn links_dir(state: State<'_, AppState>) -> String {
    state.links.dir.to_string_lossy().into_owned()
}

/// bytes the downloaded links take
#[tauri::command]
pub fn links_size(state: State<'_, AppState>) -> u64 {
    fs::read_dir(&state.links.dir).map(|d| d.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()).unwrap_or(0)
}

/// Delete every downloaded link that is not being downloaded now.
#[tauri::command]
pub fn clear_links(state: State<'_, AppState>) -> Result<u64, String> {
    let links = &state.links;
    if !links.running.lock().map_err(|e| e.to_string())?.is_empty() {
        return Err("a download is running; try again when it has finished".into());
    }
    let mut freed = 0;
    for e in fs::read_dir(&links.dir).map_err(|e| e.to_string())?.flatten() {
        if let Ok(m) = e.metadata() {
            if m.is_file() && fs::remove_file(e.path()).is_ok() {
                freed += m.len();
            }
        }
    }
    if let Ok(mut index) = links.index.lock() {
        index.clear();
    }
    let _ = fs::remove_file(&links.index_path);
    Ok(freed)
}

/// What resolve_link found: the stream URLs to play straight from the site,
/// without downloading. `audio` is set when the site serves sound as a
/// separate stream (YouTube above 360p); a <video> plays `video` and an
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
    check_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let height = height.clamp(360, 4320);
        // only plain http(s) streams: a <video> cannot play HLS (m3u8) or
        // DASH segment lists, which live streams and some sites serve
        let plain = "[protocol^=http][protocol!*=dash][protocol!*=m3u8]";
        let mut args: Vec<String> = vec![
            "--ignore-config".into(),
            "--no-playlist".into(),
            "--no-warnings".into(),
            "--encoding".into(),
            "utf-8".into(),
            "-j".into(),
            "-f".into(),
            format!("bv*[vcodec!^=hev][vcodec!^=hvc][vcodec!^=dvh]{plain}+ba{plain}/b[vcodec!^=hev][vcodec!^=hvc]{plain}/b{plain}"),
            "-S".into(),
            format!("res:{height},vcodec:h264,acodec:aac"),
        ];
        if !cookies.is_empty() {
            args.push("--cookies-from-browser".into());
            args.push(cookies);
        }
        args.push("--".into());
        args.push(url);
        let mut child = spawn(&args)?;
        let (mut out, mut err) = (child.stdout.take(), child.stderr.take());
        let readers = (
            std::thread::spawn(move || {
                let mut s = Vec::new();
                if let Some(o) = out.as_mut() {
                    let _ = o.read_to_end(&mut s);
                }
                s
            }),
            std::thread::spawn(move || {
                let mut s = Vec::new();
                if let Some(e) = err.as_mut() {
                    let _ = e.read_to_end(&mut s);
                }
                s
            }),
        );
        let started = Instant::now();
        let status = loop {
            if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
                break s;
            }
            if started.elapsed() > RESOLVE_LIMIT {
                let _ = child.kill();
                let _ = child.wait();
                return Err("yt-dlp did not answer within 90 seconds".to_string());
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let stdout = readers.0.join().unwrap_or_default();
        let stderr = readers.1.join().unwrap_or_default();
        if !status.success() {
            let err = String::from_utf8_lossy(&stderr);
            let line = err.lines().rev().find(|l| l.starts_with("ERROR")).or(err.lines().last()).unwrap_or("yt-dlp failed");
            if line.contains("Requested format is not available") {
                return Err("This link has no stream that can be played directly (live streams and some sites only offer HLS or DASH). Choose Download first.".into());
            }
            return Err(line.trim_start_matches("ERROR: ").to_string());
        }
        let text = String::from_utf8_lossy(&stdout);
        let j: serde_json::Value = serde_json::from_str(text.lines().last().unwrap_or("")).map_err(|e| format!("yt-dlp gave no readable answer: {e}"))?;
        let f = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_f64());
        let s = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        let live = j.get("is_live").and_then(|x| x.as_bool()).unwrap_or(false);
        if live {
            return Err("This is a live stream. Live streams cannot be played yet.".into());
        }
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
            live,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What Preferences shows under System: the tools links need, and the WebView2 version.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    ytdlp: Option<String>,
    ffmpeg: Option<String>,
    webview: Option<String>,
}

#[tauri::command]
pub async fn tools_info() -> Tools {
    tauri::async_runtime::spawn_blocking(|| Tools {
        ytdlp: version("yt-dlp", "--version"),
        // "ffmpeg version 7.1 Copyright ..." -> "7.1"
        ffmpeg: version("ffmpeg", "-version").map(|l| l.split_whitespace().nth(2).unwrap_or(&l).to_string()),
        webview: tauri::webview_version().ok(),
    })
    .await
    .unwrap_or(Tools { ytdlp: None, ffmpeg: None, webview: None })
}
