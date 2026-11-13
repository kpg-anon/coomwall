//! The `cw://` scheme: local files for <img> and <video>.
//!
//! The frontend builds URLs with `convertFileSrc(path, "cw")`, which on
//! Windows is `http://cw.localhost/<percent-encoded absolute path>`. Video
//! elements always send `Range:` headers; each one is answered with at most
//! [`CHUNK`] bytes read from disk, so memory use does not grow with file size.
//!
//! Only media files are served (by extension; anything else is 403), and
//! with no CORS header: the page shows them in <img> and <video>, which do
//! not need one, and no script can read other files on the disk through it.

use coomwall_engine::range::parse_range;
use percent_encoding::percent_decode_str;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tauri::http::{header, Request, Response, StatusCode};

pub const SCHEME: &str = "cw";
const CHUNK: u64 = 4 * 1024 * 1024;
/// Requests without a Range header (images) get the whole file up to this
/// size; a larger one is answered in chunks like a video.
const WHOLE_MAX: u64 = 48 * 1024 * 1024;

/// The media type, or None for a file that is not media.
fn mime(path: &Path) -> Option<&'static str> {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("jpg" | "jpeg" | "jfif") => Some("image/jpeg"),
        Some("png") => Some("image/png"),
        Some("webp") => Some("image/webp"),
        Some("gif") => Some("image/gif"),
        Some("avif") => Some("image/avif"),
        Some("bmp") => Some("image/bmp"),
        Some("mp4" | "m4v") => Some("video/mp4"),
        Some("webm") => Some("video/webm"),
        Some("mov") => Some("video/quicktime"),
        Some("mkv") => Some("video/x-matroska"),
        Some("ogv") => Some("video/ogg"),
        _ => None,
    }
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).body(Vec::new()).unwrap()
}

pub fn serve(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw = request.uri().path().trim_start_matches('/');
    let decoded = percent_decode_str(raw).decode_utf8_lossy().into_owned();
    let path = Path::new(&decoded);
    let Some(kind) = mime(path) else {
        return status(StatusCode::FORBIDDEN);
    };
    let Ok(mut file) = File::open(path) else {
        return status(StatusCode::NOT_FOUND);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());

    let builder = Response::builder()
        .header(header::CONTENT_TYPE, kind)
        .header(header::ACCEPT_RANGES, "bytes");

    match range {
        Some(value) => {
            let Some((start, end)) = parse_range(value, len) else {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                    .body(Vec::new())
                    .unwrap();
            };
            let end = end.min(start + CHUNK - 1);
            let mut body = vec![0u8; (end - start + 1) as usize];
            if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err() {
                return status(StatusCode::INTERNAL_SERVER_ERROR);
            }
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CONTENT_LENGTH, body.len())
                .body(body)
                .unwrap()
        }
        None if len <= WHOLE_MAX => {
            let mut body = Vec::with_capacity(len as usize);
            if file.read_to_end(&mut body).is_err() {
                return status(StatusCode::INTERNAL_SERVER_ERROR);
            }
            builder.status(StatusCode::OK).header(header::CONTENT_LENGTH, body.len()).body(body).unwrap()
        }
        None => {
            // Too large to send whole: hand back the first chunk as a
            // partial response, which media elements continue with ranges.
            let mut body = vec![0u8; CHUNK.min(len) as usize];
            if file.read_exact(&mut body).is_err() {
                return status(StatusCode::INTERNAL_SERVER_ERROR);
            }
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes 0-{}/{len}", body.len() - 1))
                .header(header::CONTENT_LENGTH, body.len())
                .body(body)
                .unwrap()
        }
    }
}
