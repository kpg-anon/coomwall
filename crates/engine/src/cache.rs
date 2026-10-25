//! Pixel dimensions learned from earlier runs.
//!
//! The webview measures every file the first time it is shown (image natural
//! size, video `videoWidth`/`videoHeight`). Those measurements are kept here,
//! keyed by path and invalidated when the file's size or mtime changes, so a
//! folder that has been played once opens with every aspect ratio known and
//! the portrait/landscape filter applies before anything is loaded.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Dims {
    pub size: u64,
    pub mtime: i64,
    pub w: u32,
    pub h: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dur: Option<f64>,
}

/// One measurement reported by the frontend.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DimRecord {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub dur: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DimCache {
    #[serde(default)]
    pub entries: HashMap<String, Dims>,
}

impl DimCache {
    /// A missing or unreadable cache file is an empty cache, never an error.
    pub fn load(path: &Path) -> DimCache {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Written to a temporary file first, so a crash mid-write cannot leave a
    /// truncated cache behind.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec(self)?)?;
        fs::rename(&tmp, path)
    }

    pub fn get(&self, path: &str, size: u64, mtime: i64) -> Option<Dims> {
        self.entries
            .get(path)
            .filter(|d| d.size == size && d.mtime == mtime && d.w > 0 && d.h > 0)
            .copied()
    }

    /// Returns how many entries were new or changed.
    pub fn merge(&mut self, records: Vec<DimRecord>) -> usize {
        let mut changed = 0;
        for r in records {
            if r.w == 0 || r.h == 0 {
                continue;
            }
            let dims = Dims { size: r.size, mtime: r.mtime, w: r.w, h: r.h, dur: r.dur };
            if self.entries.get(&r.path) != Some(&dims) {
                self.entries.insert(r.path, dims);
                changed += 1;
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_invalidates_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("dims.json");
        let mut cache = DimCache::default();
        let n = cache.merge(vec![DimRecord { path: "a.mp4".into(), size: 10, mtime: 5, w: 1080, h: 1920, dur: Some(3.5) }]);
        assert_eq!(n, 1);
        cache.save(&file).unwrap();
        let back = DimCache::load(&file);
        assert_eq!(back.get("a.mp4", 10, 5).unwrap().w, 1080);
        assert!(back.get("a.mp4", 11, 5).is_none(), "size changed");
        assert!(back.get("a.mp4", 10, 6).is_none(), "mtime changed");
        assert!(DimCache::load(&dir.path().join("missing.json")).entries.is_empty());
    }
}
