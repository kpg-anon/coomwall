//! The `cw://` scheme: local files for <img> and <video>.
//!
//! The frontend builds URLs with `convertFileSrc(path, "cw")`, which on
//! Windows is `http://cw.localhost/<percent-encoded absolute path>`. Video
//! elements always send `Range:` headers; each one is answered with at most
//! [`CHUNK`] bytes read from disk, so memory use does not grow with file size.

use coomwall_engine::range::parse_range;
use percent_encoding::percent_decode_str;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tauri::http::{header, Request, Response, StatusCode};

pub const SCHEME: &str = "cw";
const CHUNK: u64 = 4 * 1024 * 1024;
/// Requests without a Range header (images) get the whole file up to this size.
const WHOLE_MAX: u64 = 256 * 1024 * 1024;

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("jpg" | "jpeg" | "jfif") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        Some("ogv") => "video/ogg",
        _ => "application/octet-stream",
    }
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .unwrap()
}

pub fn serve(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw = request.uri().path().trim_start_matches('/');
    let decoded = percent_decode_str(raw).decode_utf8_lossy().into_owned();
    let path = Path::new(&decoded);
    let Ok(mut file) = File::open(path) else {
        return status(StatusCode::NOT_FOUND);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());

    let builder = Response::builder()
        .header(header::CONTENT_TYPE, mime(path))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

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
