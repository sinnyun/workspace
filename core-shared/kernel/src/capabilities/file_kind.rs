//! Concrete `file.kind` capability: one coarse, stable category per path
//! (roadmap P7-17, docs/plugin-functional/plugin-file-ops.md).
//!
//! Why this table lives in the kernel at all: three screens need the same
//! answer — the icon column (P7-34), the previewer dispatch (P7-21/22) and the
//! context menu ("open with" only makes sense for some kinds). If each kept its
//! own extension list they would drift, and the drift shows up as a previewer
//! being handed a bitmap it cannot decode. So there is exactly one table here,
//! and the frontend dev mirror of it (`apps/shell-ui/src/dev-mocks.ts`) is kept
//! row-for-row: the `FileKind` spellings themselves are wire contract, guarded
//! by `fm-contract-dump` + `contract-check`.
//!
//! Classification is **by extension only**, never by sniffing content: reading a
//! file to guess its type costs an open per row of a list that can hold 100 000
//! entries, and the Shell itself decides what to do with a file by its
//! extension. That also means an extensionless file is `unknown` — truthfully,
//! rather than as a guess.
//!
//! The categories come from [`FileKind`]'s own doc comments, which are the
//! contract: `Container` is "a video container the Shell may only iconise",
//! `Archive` covers "archives *and disk images*", and `Vector` is for what is
//! text on disk but an image on screen. That is why `.ico` is `Image` and not
//! `Vector`: an icon file is a bitmap container, and the variant's warning
//! exists precisely to keep a picture away from a code path that cannot decode
//! it. The metafile pair (`wmf`/`emf`) is the opposite case — drawing
//! instructions, so `Vector`.
//!
//! Pure: no filesystem access, no dependencies, identical on every platform, so
//! the whole table is unit-testable here (the capability it serves is
//! Windows-native, the classification is not).

use fm_contracts::capability::{FileKind, FileKindApi, FileKindOut};
use fm_contracts::CapabilityError;

/// What a path *is*, and its registered media type when it has one.
///
/// Extension (lowercase, no dot) → `(kind, mime)`. The mime half is `None`
/// where no media type is conventionally used for the format: the contract says
/// "registered media type when one is known", and the UI can show this string,
/// so a label invented here would read to the user as a fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KindEntry {
    /// Extension without the dot, lowercase — the lookup key.
    pub extension: &'static str,
    /// The category the app branches on.
    pub kind: FileKind,
    /// IANA / registered type when one exists.
    pub mime: Option<&'static str>,
}

/// The table. One row per extension, grouped by kind so a reviewer can see the
/// whole of a category at once, which is the only way a missing entry is caught.
///
/// Looked up by linear scan on purpose: this is ~150 short comparisons, and the
/// alternatives (const-hash map, `phf`, `OnceLock<HashMap>`) buy nothing for a
/// call that happens once per *visible* row and already sits behind a `stat`.
pub const BY_EXTENSION: &[KindEntry] = &[
    // Prose, logs and configuration: decodable text with no code shape.
    KindEntry { extension: "txt", kind: FileKind::Text, mime: Some("text/plain") },
    KindEntry { extension: "text", kind: FileKind::Text, mime: Some("text/plain") },
    KindEntry { extension: "log", kind: FileKind::Text, mime: Some("text/plain") },
    KindEntry { extension: "md", kind: FileKind::Markdown, mime: Some("text/markdown") },
    KindEntry { extension: "markdown", kind: FileKind::Markdown, mime: Some("text/markdown") },
    KindEntry { extension: "rst", kind: FileKind::Text, mime: None },
    // Config: `ini`/`cfg`/`conf`/`properties` have no code shape to highlight.
    KindEntry { extension: "ini", kind: FileKind::Text, mime: None },
    KindEntry { extension: "cfg", kind: FileKind::Text, mime: None },
    KindEntry { extension: "conf", kind: FileKind::Text, mime: None },
    KindEntry { extension: "properties", kind: FileKind::Text, mime: None },
    KindEntry { extension: "env", kind: FileKind::Text, mime: None },
    KindEntry { extension: "diff", kind: FileKind::Text, mime: Some("text/x-diff") },
    KindEntry { extension: "patch", kind: FileKind::Text, mime: Some("text/x-patch") },
    // Source code and structured data.
    KindEntry { extension: "rs", kind: FileKind::Code, mime: None },
    KindEntry { extension: "ts", kind: FileKind::Code, mime: None },
    KindEntry { extension: "tsx", kind: FileKind::Code, mime: None },
    KindEntry { extension: "js", kind: FileKind::Code, mime: Some("text/javascript") },
    KindEntry { extension: "mjs", kind: FileKind::Code, mime: Some("text/javascript") },
    KindEntry { extension: "cjs", kind: FileKind::Code, mime: Some("text/javascript") },
    KindEntry { extension: "jsx", kind: FileKind::Code, mime: None },
    KindEntry { extension: "py", kind: FileKind::Code, mime: Some("text/x-python") },
    KindEntry { extension: "go", kind: FileKind::Code, mime: None },
    KindEntry { extension: "c", kind: FileKind::Code, mime: Some("text/x-c") },
    KindEntry { extension: "h", kind: FileKind::Code, mime: Some("text/x-c") },
    KindEntry { extension: "cpp", kind: FileKind::Code, mime: Some("text/x-c") },
    KindEntry { extension: "hpp", kind: FileKind::Code, mime: Some("text/x-c") },
    KindEntry { extension: "cs", kind: FileKind::Code, mime: None },
    KindEntry { extension: "java", kind: FileKind::Code, mime: None },
    KindEntry { extension: "rb", kind: FileKind::Code, mime: None },
    KindEntry { extension: "php", kind: FileKind::Code, mime: None },
    KindEntry { extension: "swift", kind: FileKind::Code, mime: None },
    KindEntry { extension: "kt", kind: FileKind::Code, mime: None },
    KindEntry { extension: "lua", kind: FileKind::Code, mime: None },
    KindEntry { extension: "sql", kind: FileKind::Code, mime: Some("application/sql") },
    // A PowerShell script is text an editor opens, not a binary the Shell runs:
    // the default handler is Notepad unless the user reassociated it.
    KindEntry { extension: "ps1", kind: FileKind::Code, mime: None },
    KindEntry { extension: "psm1", kind: FileKind::Code, mime: None },
    KindEntry { extension: "sh", kind: FileKind::Code, mime: Some("application/x-sh") },
    KindEntry { extension: "json", kind: FileKind::Code, mime: Some("application/json") },
    KindEntry { extension: "jsonc", kind: FileKind::Code, mime: None },
    KindEntry { extension: "jsonl", kind: FileKind::Code, mime: None },
    KindEntry { extension: "yaml", kind: FileKind::Code, mime: Some("application/yaml") },
    KindEntry { extension: "yml", kind: FileKind::Code, mime: Some("application/yaml") },
    KindEntry { extension: "toml", kind: FileKind::Code, mime: Some("application/toml") },
    KindEntry { extension: "xml", kind: FileKind::Code, mime: Some("application/xml") },
    KindEntry { extension: "xsl", kind: FileKind::Code, mime: None },
    KindEntry { extension: "lock", kind: FileKind::Code, mime: None },
    KindEntry { extension: "html", kind: FileKind::Code, mime: Some("text/html") },
    KindEntry { extension: "htm", kind: FileKind::Code, mime: Some("text/html") },
    KindEntry { extension: "css", kind: FileKind::Code, mime: Some("text/css") },
    KindEntry { extension: "svg", kind: FileKind::Vector, mime: Some("image/svg+xml") },
    KindEntry { extension: "ai", kind: FileKind::Vector, mime: Some("application/illustrator") },
    // Raster pictures a thumbnail/preview path can decode.
    KindEntry { extension: "jpg", kind: FileKind::Image, mime: Some("image/jpeg") },
    KindEntry { extension: "jpeg", kind: FileKind::Image, mime: Some("image/jpeg") },
    KindEntry { extension: "png", kind: FileKind::Image, mime: Some("image/png") },
    KindEntry { extension: "gif", kind: FileKind::Image, mime: Some("image/gif") },
    KindEntry { extension: "bmp", kind: FileKind::Image, mime: Some("image/bmp") },
    KindEntry { extension: "webp", kind: FileKind::Image, mime: Some("image/webp") },
    KindEntry { extension: "avif", kind: FileKind::Image, mime: Some("image/avif") },
    KindEntry { extension: "tiff", kind: FileKind::Image, mime: Some("image/tiff") },
    KindEntry { extension: "tif", kind: FileKind::Image, mime: Some("image/tiff") },
    KindEntry { extension: "heic", kind: FileKind::Image, mime: Some("image/heic") },
    KindEntry { extension: "heif", kind: FileKind::Image, mime: Some("image/heif") },
    // Icons are a small bitmap *container*, not vector art: keeping them in
    // `Image` is what lets the bitmap decoder read them. `wmf`/`emf` are the
    // opposite — Windows metafiles really are drawing instructions.
    KindEntry { extension: "ico", kind: FileKind::Image, mime: Some("image/vnd.microsoft.icon") },
    KindEntry { extension: "cur", kind: FileKind::Image, mime: None },
    KindEntry { extension: "cr2", kind: FileKind::Image, mime: None },
    KindEntry { extension: "nef", kind: FileKind::Image, mime: None },
    KindEntry { extension: "arw", kind: FileKind::Image, mime: None },
    KindEntry { extension: "wmf", kind: FileKind::Vector, mime: Some("image/x-wmf") },
    KindEntry { extension: "emf", kind: FileKind::Vector, mime: Some("image/x-emf") },
    // Video the Shell can actually decode (Media Foundation): previewable, not
    // just iconisable.
    KindEntry { extension: "mp4", kind: FileKind::Video, mime: Some("video/mp4") },
    KindEntry { extension: "m4v", kind: FileKind::Video, mime: Some("video/mp4") },
    KindEntry { extension: "mov", kind: FileKind::Video, mime: Some("video/quicktime") },
    KindEntry { extension: "webm", kind: FileKind::Video, mime: Some("video/webm") },
    KindEntry { extension: "wmv", kind: FileKind::Video, mime: Some("video/x-ms-wmv") },
    // The `Container` variant's own examples: a stock Shell has no decoder for
    // these, so it can only iconise them and no previewer may be offered.
    KindEntry { extension: "mkv", kind: FileKind::Container, mime: Some("video/x-matroska") },
    KindEntry { extension: "avi", kind: FileKind::Container, mime: Some("video/x-msvideo") },
    KindEntry { extension: "mpg", kind: FileKind::Container, mime: Some("video/mpeg") },
    KindEntry { extension: "mpeg", kind: FileKind::Container, mime: Some("video/mpeg") },
    KindEntry { extension: "flv", kind: FileKind::Container, mime: Some("video/x-flv") },
    KindEntry { extension: "vob", kind: FileKind::Container, mime: None },
    // Audio — including the video containers whose payload is a stream we play
    // (`mp3`/`m4a`), which is what the variant's doc says to do.
    KindEntry { extension: "mp3", kind: FileKind::Audio, mime: Some("audio/mpeg") },
    KindEntry { extension: "m4a", kind: FileKind::Audio, mime: Some("audio/mp4") },
    KindEntry { extension: "flac", kind: FileKind::Audio, mime: Some("audio/flac") },
    KindEntry { extension: "wav", kind: FileKind::Audio, mime: Some("audio/wav") },
    KindEntry { extension: "aac", kind: FileKind::Audio, mime: Some("audio/aac") },
    KindEntry { extension: "ogg", kind: FileKind::Audio, mime: Some("audio/ogg") },
    KindEntry { extension: "oga", kind: FileKind::Audio, mime: Some("audio/ogg") },
    KindEntry { extension: "opus", kind: FileKind::Audio, mime: Some("audio/opus") },
    KindEntry { extension: "wma", kind: FileKind::Audio, mime: Some("audio/x-ms-wma") },
    KindEntry { extension: "mid", kind: FileKind::Audio, mime: Some("audio/midi") },
    KindEntry { extension: "pdf", kind: FileKind::Pdf, mime: Some("application/pdf") },
    // Archives *and* disk images: a previewer can list all of them. Windows
    // mounts `iso`/`vhd` itself, so "only iconisable" would be a lie.
    KindEntry { extension: "zip", kind: FileKind::Archive, mime: Some("application/zip") },
    KindEntry { extension: "tar", kind: FileKind::Archive, mime: Some("application/x-tar") },
    KindEntry { extension: "gz", kind: FileKind::Archive, mime: Some("application/gzip") },
    KindEntry { extension: "tgz", kind: FileKind::Archive, mime: Some("application/gzip") },
    KindEntry { extension: "bz2", kind: FileKind::Archive, mime: Some("application/x-bzip2") },
    KindEntry { extension: "xz", kind: FileKind::Archive, mime: Some("application/x-xz") },
    KindEntry { extension: "7z", kind: FileKind::Archive, mime: Some("application/x-7z-compressed") },
    KindEntry { extension: "rar", kind: FileKind::Archive, mime: Some("application/vnd.rar") },
    KindEntry { extension: "cab", kind: FileKind::Archive, mime: Some("application/vnd.ms-cab-compressed") },
    KindEntry { extension: "iso", kind: FileKind::Archive, mime: Some("application/x-iso9660-image") },
    KindEntry { extension: "vhd", kind: FileKind::Archive, mime: Some("application/x-vhd") },
    KindEntry { extension: "vhdx", kind: FileKind::Archive, mime: Some("application/x-vhdx") },
    // Office: the legacy binary types have no registered media type worth
    // claiming, so they report `None` rather than a made-up one.
    KindEntry { extension: "doc", kind: FileKind::Document, mime: None },
    KindEntry {
        extension: "docx",
        kind: FileKind::Document,
        mime: Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    },
    KindEntry { extension: "odt", kind: FileKind::Document, mime: Some("application/vnd.oasis.opendocument.text") },
    KindEntry { extension: "rtf", kind: FileKind::Document, mime: Some("application/rtf") },
    KindEntry { extension: "epub", kind: FileKind::Document, mime: Some("application/epub+zip") },
    KindEntry { extension: "xls", kind: FileKind::Sheet, mime: None },
    KindEntry {
        extension: "xlsx",
        kind: FileKind::Sheet,
        mime: Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    },
    KindEntry { extension: "ods", kind: FileKind::Sheet, mime: Some("application/vnd.oasis.opendocument.spreadsheet") },
    // `csv` is a sheet, not prose: the previewer renders it as a grid, and the
    // alternative (text) would silently lose the column view the user expects.
    KindEntry { extension: "csv", kind: FileKind::Sheet, mime: Some("text/csv") },
    KindEntry { extension: "tsv", kind: FileKind::Sheet, mime: Some("text/tab-separated-values") },
    KindEntry { extension: "ppt", kind: FileKind::Presentation, mime: None },
    KindEntry {
        extension: "pptx",
        kind: FileKind::Presentation,
        mime: Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    },
    KindEntry { extension: "odp", kind: FileKind::Presentation, mime: Some("application/vnd.oasis.opendocument.presentation") },
    KindEntry { extension: "key", kind: FileKind::Presentation, mime: None },
    KindEntry { extension: "ttf", kind: FileKind::Font, mime: Some("font/ttf") },
    KindEntry { extension: "otf", kind: FileKind::Font, mime: Some("font/otf") },
    KindEntry { extension: "woff", kind: FileKind::Font, mime: Some("font/woff") },
    KindEntry { extension: "woff2", kind: FileKind::Font, mime: Some("font/woff2") },
    // Binaries: never previewed, only revealed or opened with care (contract
    // doc on `Executable`). `msi`/`msp` install, `sys`/`ocx` are loaded.
    KindEntry { extension: "exe", kind: FileKind::Executable, mime: Some("application/x-msdownload") },
    KindEntry { extension: "dll", kind: FileKind::Executable, mime: Some("application/x-msdownload") },
    KindEntry { extension: "ocx", kind: FileKind::Executable, mime: None },
    KindEntry { extension: "sys", kind: FileKind::Executable, mime: None },
    KindEntry { extension: "msi", kind: FileKind::Executable, mime: Some("application/x-msdownload") },
    KindEntry { extension: "msp", kind: FileKind::Executable, mime: None },
    KindEntry { extension: "appx", kind: FileKind::Executable, mime: Some("application/vnd.ms-appx") },
    KindEntry { extension: "msix", kind: FileKind::Executable, mime: None },
    KindEntry { extension: "com", kind: FileKind::Executable, mime: None },
    KindEntry { extension: "scr", kind: FileKind::Executable, mime: None },
    // Batch files belong here, not with source code: double-clicking one *runs*
    // it, which is the care the `Executable` doc asks the UI to take.
    KindEntry { extension: "bat", kind: FileKind::Executable, mime: None },
    KindEntry { extension: "cmd", kind: FileKind::Executable, mime: None },
    // Specialist payloads we can only iconise (`Model`'s own doc).
    KindEntry { extension: "blend", kind: FileKind::Model, mime: None },
    KindEntry { extension: "dwg", kind: FileKind::Model, mime: Some("image/vnd.dwg") },
    KindEntry { extension: "dxf", kind: FileKind::Model, mime: Some("image/vnd.dxf") },
    KindEntry { extension: "step", kind: FileKind::Model, mime: Some("model/step") },
    KindEntry { extension: "stp", kind: FileKind::Model, mime: Some("model/step") },
    KindEntry { extension: "iges", kind: FileKind::Model, mime: Some("model/iges") },
    KindEntry { extension: "igs", kind: FileKind::Model, mime: Some("model/iges") },
    KindEntry { extension: "stl", kind: FileKind::Model, mime: Some("model/stl") },
    KindEntry { extension: "obj", kind: FileKind::Model, mime: Some("model/obj") },
    KindEntry { extension: "glb", kind: FileKind::Model, mime: Some("model/gltf-binary") },
    KindEntry { extension: "gltf", kind: FileKind::Model, mime: Some("model/gltf+json") },
    KindEntry { extension: "fbx", kind: FileKind::Model, mime: None },
    KindEntry { extension: "3ds", kind: FileKind::Model, mime: None },
    KindEntry { extension: "u3d", kind: FileKind::Model, mime: Some("model/u3d") },
];

/// [`FileKind`] for one extension, plus its registered media type.
///
/// `unknown` is the answer for anything not in [`BY_EXTENSION`], including a
/// blank extension — [`FileKind::Unknown`]'s doc says it covers extensionless
/// files, so there is no separate "no extension" category to invent.
pub fn kind_of_extension(extension: &str) -> (FileKind, Option<&'static str>) {
    BY_EXTENSION
        .iter()
        .find(|entry| entry.extension == extension)
        .map_or((FileKind::Unknown, None), |entry| {
            (entry.kind, entry.mime)
        })
}

/// The extension of a path: lowercase, no dot, `""` when there is none.
///
/// Splits on **both** separators instead of `std::path`: this table is queried
/// with Windows paths whatever the build host, and `Path` on Linux reads
/// `C:\dir\a.txt` as one filename whose "extension" happens to be `txt` only by
/// accident. Splitting on both is the spelling the Shell itself accepts.
///
/// A leading dot is not a separator (`.gitignore` *is* the name), matching
/// `Path::extension` — otherwise the table would need a row for every dotfile
/// spelled without its dot.
fn extension_of(path: &str) -> String {
    let trimmed = path.trim_end_matches(|c| c == '/' || c == '\\');
    let name = match trimmed.rfind(['/', '\\']) {
        Some(index) => &trimmed[index + 1..],
        None => trimmed,
    };
    match name.rfind('.') {
        // Index 0 is a dotfile; a trailing dot (`a.`) has no extension either.
        Some(index) if index > 0 && index + 1 < name.len() => {
            name[index + 1..].to_lowercase()
        }
        _ => String::new(),
    }
}

/// The concrete [`FileKindApi`]: a stateless lookup over [`BY_EXTENSION`].
#[derive(Debug, Default, Clone, Copy)]
pub struct FileKinds;

impl FileKinds {
    /// Build the classifier. Takes nothing because it owns nothing.
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

impl FileKindApi for FileKinds {
    fn classify(&self, path: &str, is_dir: bool) -> Result<FileKindOut, CapabilityError> {
        if path.trim().is_empty() {
            // Chinese because the host surfaces this text to the user.
            return Err(CapabilityError::InvalidArgument(
                "路径为空".to_owned(),
            ));
        }
        // A directory answer carries no extension: `folder.zip` opened as a folder
        // is a folder, and reporting `zip` would have the UI offer "list archive"
        // for it. The caller already paid for the stat; its answer wins.
        if is_dir {
            return Ok(FileKindOut {
                path: path.to_owned(),
                kind: FileKind::Directory,
                extension: String::new(),
                mime: None,
            });
        }
        let extension = extension_of(path);
        let (kind, mime) = kind_of_extension(&extension);
        Ok(FileKindOut {
            path: path.to_owned(),
            kind,
            // Reported as it was read, even when the kind is `unknown`: the
            // contract documents this field as "lowercase extension without the
            // dot, empty when there is none", and the UI needs the real one to
            // explain *why* nothing matched.
            extension,
            mime: mime.map(str::to_owned),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table is the product: a duplicated extension means the first match
    /// wins and the second row is a silent lie, so neither is allowed.
    #[test]
    fn the_table_has_one_row_per_extension() {
        let mut seen = std::collections::HashSet::new();
        for entry in BY_EXTENSION {
            assert!(
                seen.insert(entry.extension),
                "extension `{}` is listed twice",
                entry.extension
            );
            assert_eq!(
                entry.extension,
                entry.extension.to_lowercase(),
                "lookup keys are compared as written: `{}` would never match",
                entry.extension
            );
            assert!(!entry.extension.contains('.'), "`{}` carries a dot", entry.extension);
        }
    }

    /// An entry whose extension key is not the one the classifier would produce
    /// would be dead code that *looks* covered.
    #[test]
    fn every_extension_is_reachable_through_the_path_rule() {
        for entry in BY_EXTENSION {
            let classified = FileKinds
                .classify(&format!(r"C:\dir\a.{}", entry.extension), false)
                .expect("a path classifies");
            assert_eq!(classified.extension, entry.extension, "{entry:?}");
            assert_eq!(classified.kind, entry.kind, "{entry:?}");
            assert_eq!(classified.mime.as_deref(), entry.mime, "{entry:?}");
        }
    }

    #[test]
    fn a_directory_is_a_directory_whatever_it_is_called() {
        for path in [
            r"C:\Users\me\archive.zip",
            r"C:\Videos\mkv",
            r"C:\No Extension",
        ] {
            let out = FileKinds.classify(path, true).expect("a directory classifies");
            assert_eq!(out.kind, FileKind::Directory, "{path}");
            assert_eq!(out.extension, "", "{path} carries no extension");
            assert_eq!(out.mime, None, "{path}");
            assert_eq!(out.path, path, "the caller's identity comes back unchanged");
        }
    }

    /// The distinctions the app actually branches on, spelled out rather than
    /// trusted to the table's grouping.
    #[test]
    fn the_categories_the_ui_dispatches_on() {
        for (path, kind) in [
            ("报告 v1.txt", FileKind::Text),
            ("config.ini", FileKind::Text),
            ("server.log", FileKind::Text),
            ("notes.md", FileKind::Markdown),
            ("Cargo.toml", FileKind::Code),
            ("data.json", FileKind::Code),
            ("main.rs", FileKind::Code),
            ("diagram.svg", FileKind::Vector),
            // A bitmap must reach the bitmap decoder: `Vector` means "not a
            // picture path", and `.ico` is a picture path.
            ("favicon.ico", FileKind::Image),
            ("photo.JPG", FileKind::Image),
            ("clip.mp4", FileKind::Video),
            // The Shell has no decoder for these, so they are only iconisable.
            ("film.mkv", FileKind::Container),
            ("film.avi", FileKind::Container),
            ("song.mp3", FileKind::Audio),
            // An m4a is a video *container* whose stream is audio — `Audio`'s doc
            // says so explicitly, and it overrides the container rule above.
            ("song.m4a", FileKind::Audio),
            ("paper.pdf", FileKind::Pdf),
            // Disk images are archives: a previewer lists them.
            ("ubuntu.iso", FileKind::Archive),
            ("disk.vhdx", FileKind::Archive),
            ("backup.zip", FileKind::Archive),
            ("报告.docx", FileKind::Document),
            ("表.xlsx", FileKind::Sheet),
            ("清单.csv", FileKind::Sheet),
            ("幻灯片.pptx", FileKind::Presentation),
            ("font.ttf", FileKind::Font),
            ("setup.exe", FileKind::Executable),
            ("model.glb", FileKind::Model),
        ] {
            let out = FileKinds.classify(path, false).expect(path);
            assert_eq!(out.kind, kind, "{path}");
        }
    }

    /// Anything unlisted — and anything with no extension at all — is
    /// `unknown`, with the extension still reported when there was one to read.
    #[test]
    fn unlisted_and_extensionless_are_unknown() {
        for (path, extension) in [
            (r"C:\Windows\explorer", ""),
            ("readme.markdown2", "markdown2"),
            (r"C:\dir\weird.zzip", "zzip"),
            // A dotfile's name is its own: there is no extension to blame.
            (r"C:\dir\.hidden", ""),
            ("a.", ""),
        ] {
            let out = FileKinds.classify(path, false).expect(path);
            assert_eq!(out.kind, FileKind::Unknown, "{path}");
            assert_eq!(out.extension, extension, "{path}");
            assert_eq!(out.mime, None, "{path}");
        }
    }

    /// Only a real path is refused, and with the frozen prefix the frontend
    /// classifies on.
    #[test]
    fn an_empty_path_is_a_caller_bug() {
        for path in ["", "   "] {
            let err = FileKinds
                .classify(path, false)
                .expect_err("nothing to classify");
            assert!(
                err.to_string().starts_with("invalid argument:"),
                "wire contract: {err}"
            );
        }
    }

    /// Where the extension is read from: both separators, uppercase folded, and
    /// a path whose *directory* names contain dots.
    #[test]
    fn the_extension_comes_from_the_file_name_only() {
        for (path, extension) in [
            (r"C:\a.b\c.zip", "zip"),
            ("/v1.2/data.json", "json"),
            (r"\\server\share\clip.MOV", "mov"),
            ("archive.tar.gz", "gz"),
            (r"C:\Program Files\One.dll", "dll"),
        ] {
            assert_eq!(extension_of(path), extension, "{path}");
        }
        for path in [r"C:\a\", r"C:\a\\", "/tmp/", "note", ".gitignore", ""] {
            assert_eq!(extension_of(path), "", "{path}");
        }
    }

    /// The wire spelling is the contract: kebab-case kinds, camelCase fields,
    /// and `mime: null` (not an absent key) so the SDK's `string | null` holds.
    #[test]
    fn the_answer_matches_the_frozen_wire_shape() {
        let out = FileKinds.classify(r"C:\a\report.pdf", false).expect("pdf");
        let json = serde_json::to_value(&out).expect("serialisable");
        assert_eq!(json["kind"], "pdf");
        assert_eq!(json["extension"], "pdf");
        assert_eq!(json["mime"], "application/pdf");
        assert_eq!(json["path"], r"C:\a\report.pdf");

        let unknown = FileKinds.classify("/x/bin", false).expect("unknown");
        let json = serde_json::to_value(&unknown).expect("serialisable");
        assert_eq!(json["kind"], "unknown");
        assert!(json.get("mime").is_some(), "mime must be present as null");
        assert_eq!(json["mime"], serde_json::Value::Null);

        assert_eq!(serde_json::to_value(FileKind::Markdown).expect("md"), "markdown");
        assert_eq!(
            serde_json::to_value(FileKind::Directory).expect("dir"),
            "directory"
        );
    }

    /// Every kind the table is supposed to *produce from an extension* must have at
    /// least one row, or the UI has a category nothing can reach. `Unknown` is the
    /// fallback branch itself (`kind_of_extension` answers it for anything unlisted,
    /// extensionless files included), so it can never have a row by definition.
    #[test]
    fn every_category_has_rows() {
        for kind in [
            FileKind::Text,
            FileKind::Code,
            FileKind::Markdown,
            FileKind::Image,
            FileKind::Vector,
            FileKind::Video,
            FileKind::Audio,
            FileKind::Container,
            FileKind::Pdf,
            FileKind::Archive,
            FileKind::Document,
            FileKind::Sheet,
            FileKind::Presentation,
            FileKind::Font,
            FileKind::Executable,
            FileKind::Model,
        ] {
            let found = BY_EXTENSION.iter().any(|entry| entry.kind == kind);
            assert!(found, "no extension ever classifies as {kind:?}");
        }
    }
}
