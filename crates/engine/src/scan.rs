//! Turn the sources the user added (folders, playlists, single files, URLs)
//! into one de-duplicated list of media entries.

use crate::cache::DimCache;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};
use walkdir::WalkDir;

pub const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "jfif", "png", "webp", "gif", "avif", "bmp"];
pub const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "webm", "mov", "mkv", "ogv"];
pub const PLAYLIST_EXTS: &[&str] = &["m3u", "m3u8"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Image,
    Video,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub kind: Kind,
    pub size: u64,
    pub mtime: i64,
    pub w: Option<u32>,
    pub h: Option<u32>,
    pub dur: Option<f64>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub items: Vec<Entry>,
    pub images: usize,
    pub videos: usize,
    /// how many entries already had their dimensions cached
    pub known: usize,
    /// entries left out because the user chose "never show again"
    pub hidden: usize,
    pub errors: Vec<String>,
    pub millis: u64,
}

pub fn is_url(s: &str) -> bool {
    let l = s.trim_start().to_ascii_lowercase();
    l.starts_with("http://") || l.starts_with("https://")
}

fn ext_of(path: &str) -> String {
    let bare = path.split(['?', '#']).next().unwrap_or(path);
    Path::new(bare)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn kind_of(path: &str) -> Option<Kind> {
    let ext = ext_of(path);
    if IMAGE_EXTS.contains(&ext.as_str()) {
        Some(Kind::Image)
    } else if VIDEO_EXTS.contains(&ext.as_str()) {
        Some(Kind::Video)
    } else {
        None
    }
}

/// Folders that are never media: hidden ones (including comfysort's
/// `.comfysort` journal and `.trash`) and Windows system folders.
fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case("$RECYCLE.BIN") || name.eq_ignore_ascii_case("System Volume Information")
}

/// A path on another computer: `\\host\share`, `//host/share`, `\\?\UNC\…`,
/// or `file://host/…` once its scheme is stripped. `\\?\C:\` and `\\.\` are local.
pub fn is_network(path: &str) -> bool {
    let p = path.trim().replace('/', "\\");
    if p.to_ascii_uppercase().starts_with(r"\\?\UNC\") {
        return true;
    }
    p.starts_with(r"\\") && !p.starts_with(r"\\?\") && !p.starts_with(r"\\.\")
}

/// Entries of an `.m3u`, local paths resolved against the playlist's folder.
/// `#EXTINF` and other directives are skipped; a non-UTF-8 file is read lossily.
pub fn read_m3u(path: &Path) -> std::io::Result<Vec<String>> {
    let bytes = fs::read(path)?;
    let text = String::from_utf8_lossy(&bytes);
    let base = path.parent().map(Path::to_path_buf).unwrap_or_default();
    // A network path (\\host\share\x.mp4) in a playlist makes Windows log in
    // to that host as soon as the path is touched, which sends the user's
    // password hash there. Only a playlist that is itself on a network share
    // may point at one.
    let on_share = is_network(&path.to_string_lossy());
    Ok(text
        .lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}'))
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter(|l| {
            // file:///C:/x is local, file://host/x is on another computer
            let p = match (l.strip_prefix("file:///"), l.strip_prefix("file://")) {
                (Some(local), _) => local.to_string(),
                (None, Some(host)) => format!(r"\\{host}"),
                _ => l.to_string(),
            };
            on_share || is_url(l) || !is_network(&p)
        })
        .map(|l| {
            if is_url(l) {
                l.to_string()
            } else {
                let l = l.strip_prefix("file:///").unwrap_or(l);
                let p = PathBuf::from(l);
                if p.is_absolute() { p } else { base.join(p) }.to_string_lossy().into_owned()
            }
        })
        .collect())
}

struct Collector<'a> {
    cache: &'a DimCache,
    seen: HashSet<String>,
    report: ScanReport,
}

/// How two spellings of one path compare: case-insensitively on Windows.
pub fn path_key(path: &str) -> String {
    if cfg!(windows) { path.to_lowercase().replace('/', "\\") } else { path.to_string() }
}

impl ScanReport {
    /// Drop the entries whose `path_key` is in `hidden`, keeping the counts right.
    pub fn without(mut self, hidden: &HashSet<String>) -> Self {
        if hidden.is_empty() {
            return self;
        }
        let before = self.items.len();
        self.items.retain(|e| !hidden.contains(&path_key(&e.path)));
        self.hidden = before - self.items.len();
        self.images = self.items.iter().filter(|e| e.kind == Kind::Image).count();
        self.videos = self.items.len() - self.images;
        self.known = self.items.iter().filter(|e| e.w.is_some() && e.h.is_some()).count();
        self
    }
}

impl Collector<'_> {
    fn key(path: &str) -> String {
        path_key(path)
    }

    fn add_url(&mut self, url: &str) {
        if !self.seen.insert(url.to_string()) {
            return;
        }
        let kind = kind_of(url).unwrap_or(Kind::Video);
        let dims = self.cache.get(url, 0, 0);
        self.push(Entry {
            path: url.to_string(),
            kind,
            size: 0,
            mtime: 0,
            w: dims.map(|d| d.w),
            h: dims.map(|d| d.h),
            dur: dims.and_then(|d| d.dur),
        });
    }

    fn add_file(&mut self, path: &Path, meta: Option<fs::Metadata>) {
        let Some(s) = path.to_str() else { return };
        let Some(kind) = kind_of(s) else { return };
        if !self.seen.insert(Self::key(s)) {
            return;
        }
        let meta = meta.or_else(|| fs::metadata(path).ok());
        let size = meta.as_ref().map_or(0, |m| m.len());
        let mtime = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs() as i64);
        let dims = self.cache.get(s, size, mtime);
        self.push(Entry {
            path: s.to_string(),
            kind,
            size,
            mtime,
            w: dims.map(|d| d.w),
            h: dims.map(|d| d.h),
            dur: dims.and_then(|d| d.dur),
        });
    }

    fn push(&mut self, e: Entry) {
        match e.kind {
            Kind::Image => self.report.images += 1,
            Kind::Video => self.report.videos += 1,
        }
        if e.w.is_some() {
            self.report.known += 1;
        }
        self.report.items.push(e);
    }

    fn add_dir(&mut self, dir: &Path, recursive: bool) {
        let walker = WalkDir::new(dir)
            .follow_links(true)
            .max_depth(if recursive { usize::MAX } else { 1 })
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_type().is_dir() || !skip_dir(&e.file_name().to_string_lossy()));
        for entry in walker {
            match entry {
                Ok(e) if e.file_type().is_file() => {
                    let meta = e.metadata().ok();
                    self.add_file(e.path(), meta);
                }
                Ok(_) => {}
                Err(err) => {
                    if self.report.errors.len() < 20 {
                        self.report.errors.push(err.to_string());
                    }
                }
            }
        }
    }

    fn add_playlist(&mut self, path: &Path) {
        match read_m3u(path) {
            Ok(lines) => {
                for line in lines {
                    if is_url(&line) {
                        self.add_url(&line);
                    } else {
                        let p = PathBuf::from(&line);
                        if p.is_file() {
                            self.add_file(&p, None);
                        }
                    }
                }
            }
            Err(err) => self.report.errors.push(format!("{}: {err}", path.display())),
        }
    }
}

pub fn scan(sources: &[String], recursive: bool, cache: &DimCache) -> ScanReport {
    let started = Instant::now();
    let mut c = Collector { cache, seen: HashSet::new(), report: ScanReport::default() };
    for source in sources.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if is_url(source) {
            c.add_url(source);
            continue;
        }
        let path = Path::new(source);
        if path.is_dir() {
            c.add_dir(path, recursive);
        } else if path.is_file() {
            if PLAYLIST_EXTS.contains(&ext_of(source).as_str()) {
                c.add_playlist(path);
            } else {
                c.add_file(path, None);
            }
        } else {
            c.report.errors.push(format!("not found: {source}"));
        }
    }
    c.report.millis = started.elapsed().as_millis() as u64;
    c.report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::DimRecord;

    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, b"x").unwrap();
    }

    #[test]
    fn a_local_playlist_never_points_at_another_computer() {
        let dir = tempfile::tempdir().unwrap();
        let list = dir.path().join("list.m3u");
        fs::write(&list, "\\\\evil\\s\\a.mp4\n//evil/s/b.mp4\nfile://evil/s/c.mp4\n\\\\?\\UNC\\evil\\s\\d.mp4\nfile:///C:/v/e.mp4\nf.mp4\nhttps://example.com/g.mp4\n").unwrap();
        let got = read_m3u(&list).unwrap();
        assert_eq!(got.len(), 3, "{got:?}");
        assert!(got.iter().any(|p| p.ends_with("e.mp4")) && got.iter().any(|p| p.ends_with("f.mp4")) && got.iter().any(|p| p.ends_with("g.mp4")));
        assert!(is_network(r"\\nas\media") && !is_network(r"\\?\C:\x") && !is_network(r"C:\x"));
    }

    #[test]
    fn walks_filters_dedupes_and_reads_playlists() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("a.jpg"));
        touch(&root.join("b.MP4"));
        touch(&root.join("notes.txt"));
        touch(&root.join("sub/c.webm"));
        touch(&root.join(".trash/d.png"));
        fs::write(root.join("list.m3u"), "#EXTM3U\n#EXTINF:-1,x\na.jpg\nsub/c.webm\nhttps://example.com/v.mp4\nmissing.mp4\n").unwrap();

        let cache = DimCache::default();
        let flat = scan(&[root.to_string_lossy().into_owned()], false, &cache);
        assert_eq!((flat.images, flat.videos), (1, 1), "top level only: a.jpg, b.MP4");

        let deep = scan(&[root.to_string_lossy().into_owned()], true, &cache);
        assert_eq!((deep.images, deep.videos), (1, 2), ".trash skipped, sub/ included");

        let both = scan(
            &[root.to_string_lossy().into_owned(), root.join("list.m3u").to_string_lossy().into_owned()],
            true,
            &cache,
        );
        assert_eq!(both.items.len(), 4, "playlist entries already found by the walk are not repeated; the URL is new");
        assert!(both.items.iter().any(|e| e.path == "https://example.com/v.mp4" && e.kind == Kind::Video));
    }

    #[test]
    fn hidden_entries_are_dropped_and_counted() {
        let dir = tempfile::tempdir().unwrap();
        for n in ["a.png", "b.mp4", "c.mp4"] {
            touch(&dir.path().join(n));
        }
        let all = scan(&[dir.path().to_string_lossy().into_owned()], false, &DimCache::default());
        assert_eq!(all.items.len(), 3);
        let b = all.items.iter().find(|e| e.path.ends_with("b.mp4")).unwrap().path.clone();
        // a different spelling of the same file still matches on Windows
        let spelled = if cfg!(windows) { b.to_uppercase() } else { b.clone() };
        let hidden: HashSet<String> = [path_key(&spelled)].into();
        let left = all.without(&hidden);
        assert_eq!((left.items.len(), left.images, left.videos, left.hidden), (2, 1, 1, 1));
        assert!(!left.items.iter().any(|e| e.path == b));
    }

    #[test]
    fn cached_dimensions_come_back_with_the_scan() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.png");
        touch(&file);
        let first = scan(&[file.to_string_lossy().into_owned()], false, &DimCache::default());
        let e = &first.items[0];
        let mut cache = DimCache::default();
        cache.merge(vec![DimRecord { path: e.path.clone(), size: e.size, mtime: e.mtime, w: 640, h: 480, dur: None }]);
        let again = scan(&[file.to_string_lossy().into_owned()], false, &cache);
        assert_eq!((again.items[0].w, again.items[0].h), (Some(640), Some(480)));
        assert_eq!(again.known, 1);
    }
}
