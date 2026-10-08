//! Concrete `thumb` capability: decode an image and hand back a small PNG as a
//! `data:` URL (docs/06 §4 — the `image` crate does the decoding, nothing else
//! here does).
//!
//! Kept out of `fs` on purpose: a directory listing must stay a metadata walk,
//! while decoding is expensive, opt-in, and only ever wanted for the rows
//! currently visible. Results are cached per `(path, edge)` and revalidated
//! against the file's mtime, so an edited image refreshes without a purge hook.

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::sync::Arc;

use base64::Engine as _;
use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader};
use parking_lot::Mutex;

use fm_contracts::capability::{CapabilityError, ThumbApi, ThumbOut};

use crate::capabilities::fs::mtime_ms;

/// Extensions the decoder will even open a file for. Anything else is an
/// argument error, not an I/O failure — callers ask for real images.
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff"];

/// Longest edge a caller may ask for. A grid card needs ~128px, so 512 already
/// covers retina; the cap bounds both decode cost and cache size.
pub const MAX_EDGE: u32 = 512;

/// Decoded thumbnails held in memory. The cache is dropped wholesale when full:
/// losing thumbnails is harmless, holding hundreds of MB is not.
const CACHE_LIMIT: usize = 2048;

struct CacheEntry {
    out: Arc<ThumbOut>,
    /// mtime the thumbnail was rendered from, for staleness checks.
    modified_ms: Option<i64>,
}

/// [`ThumbApi`] over the `image` crate decoder.
#[derive(Default)]
pub struct ImageThumbs {
    cache: Mutex<HashMap<(String, u32), CacheEntry>>,
}

impl ImageThumbs {
    /// An empty thumbnail cache.
    pub fn new() -> Self {
        Self::default()
    }
}

fn extension_of(path: &str) -> String {
    let tail = match path.rsplit_once('.') {
        Some((_, ext)) => ext,
        None => return String::new(),
    };
    if tail.is_empty() || tail.contains(['/', '\\']) {
        return String::new();
    }
    tail.to_ascii_lowercase()
}

impl ThumbApi for ImageThumbs {
    fn image(&self, path: &str, edge: u32) -> Result<ThumbOut, CapabilityError> {
        if edge == 0 || edge > MAX_EDGE {
            return Err(CapabilityError::InvalidArgument(format!(
                "edge must be in 1..={MAX_EDGE}, got {edge}"
            )));
        }
        let ext = extension_of(path);
        if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
            return Err(CapabilityError::InvalidArgument(format!(
                "{path} is not a supported image (extension: {})",
                if ext.is_empty() { "none" } else { &ext }
            )));
        }

        let meta = fs::metadata(path).map_err(CapabilityError::from_io)?;
        if meta.is_dir() {
            return Err(CapabilityError::InvalidArgument(format!(
                "{path} is a directory"
            )));
        }
        let modified_ms = mtime_ms(&meta);

        let key = (path.to_owned(), edge);
        {
            let cache = self.cache.lock();
            if let Some(hit) = cache.get(&key) {
                if hit.modified_ms == modified_ms {
                    return Ok(Arc::clone(&hit.out).as_ref().clone());
                }
            }
        }

        let out = render(path, edge)?;

        let mut cache = self.cache.lock();
        if cache.len() >= CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(
            key,
            CacheEntry {
                out: Arc::new(out.clone()),
                modified_ms,
            },
        );
        Ok(out)
    }
}

/// Decode, downscale so the longest edge is at most `edge`, encode PNG, wrap in
/// a `data:` URL.
fn render(path: &str, edge: u32) -> Result<ThumbOut, CapabilityError> {
    let img: DynamicImage = ImageReader::open(path)
        .map_err(CapabilityError::from_io)?
        .with_guessed_format()
        .map_err(CapabilityError::from_io)?
        .decode()
        .map_err(|e| CapabilityError::Io(format!("decode {path}: {e}")))?;

    let (width, height) = img.dimensions();
    let longest = width.max(height);
    let size = if longest == 0 || longest <= edge {
        (width, height)
    } else {
        let scale = f64::from(edge) / f64::from(longest);
        let w = ((f64::from(width) * scale).round() as u32).max(1);
        let h = ((f64::from(height) * scale).round() as u32).max(1);
        (w, h)
    };

    let resized = if size == (width, height) {
        img
    } else {
        img.resize(size.0, size.1, image::imageops::FilterType::Triangle)
    };

    let mut png = Cursor::new(Vec::new());
    resized
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|e| CapabilityError::Io(format!("encode png: {e}")))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    Ok(ThumbOut {
        data_url: format!("data:image/png;base64,{b64}"),
        mime: "image/png".to_owned(),
        edge,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real PNG written to disk, so decode -> resize -> encode runs on actual
    /// image bytes rather than a fixture string.
    fn write_png(dir: &std::path::Path, name: &str, w: u32, h: u32) -> std::path::PathBuf {
        let mut img = image::RgbImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        let path = dir.join(name);
        image::DynamicImage::ImageRgb8(img)
            .save_with_format(&path, ImageFormat::Png)
            .unwrap();
        path
    }

    fn decoded_bytes(out: &ThumbOut) -> Vec<u8> {
        let payload = out.data_url.strip_prefix("data:image/png;base64,").unwrap();
        base64::engine::general_purpose::STANDARD
            .decode(payload)
            .unwrap()
    }

    #[test]
    fn downscales_a_real_image_keeping_aspect() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_png(dir.path(), "big.png", 900, 600);

        let out = ImageThumbs::new().image(path.to_str().unwrap(), 64).unwrap();

        assert_eq!(out.mime, "image/png");
        assert_eq!(out.edge, 64);
        assert_eq!(
            image::load_from_memory(&decoded_bytes(&out))
                .unwrap()
                .dimensions(),
            (64, 43),
            "longest edge 64, aspect kept"
        );
    }

    #[test]
    fn small_images_pass_through_and_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_png(dir.path(), "small.png", 20, 12);
        let thumbs = ImageThumbs::new();
        let p = path.to_str().unwrap();

        let first = thumbs.image(p, 64).unwrap();
        assert_eq!(
            image::load_from_memory(&decoded_bytes(&first))
                .unwrap()
                .dimensions(),
            (20, 12)
        );
        assert_eq!(thumbs.cache.lock().len(), 1);
        assert_eq!(thumbs.image(p, 64).unwrap(), first, "second call hits the cache");
        assert_eq!(thumbs.cache.lock().len(), 1);

        // An edited file must not return the stale thumbnail.
        write_png(dir.path(), "small.png", 30, 12);
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert_ne!(thumbs.image(p, 64).unwrap(), first);
    }

    #[test]
    fn rejects_non_images_and_out_of_range_edges() {
        let dir = tempfile::tempdir().unwrap();
        let txt = dir.path().join("notes.txt");
        std::fs::write(&txt, "hello").unwrap();
        let thumbs = ImageThumbs::new();

        assert!(matches!(
            thumbs.image(txt.to_str().unwrap(), 64),
            Err(CapabilityError::InvalidArgument(_))
        ));
        let p = write_png(dir.path(), "p.png", 8, 8);
        let p = p.to_str().unwrap();
        assert!(matches!(
            thumbs.image(p, 0),
            Err(CapabilityError::InvalidArgument(_))
        ));
        assert!(matches!(
            thumbs.image(p, MAX_EDGE + 1),
            Err(CapabilityError::InvalidArgument(_))
        ));
        assert!(matches!(
            thumbs.image(dir.path().join("missing.png").to_str().unwrap(), 64),
            Err(CapabilityError::NotFound(_))
        ));
    }
}
