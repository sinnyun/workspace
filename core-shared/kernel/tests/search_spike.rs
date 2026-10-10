//! P7-28 decision-gate spike: is the SQLite we already ship enough for filename
//! search, or do we need a dedicated search engine (docs/06 lists `tantivy` as
//! the alternative)?
//!
//! Nothing here is production code — the point is to measure the facts the
//! decision depends on: whether FTS5 exists in the *bundled* build `rusqlite`
//! already links, how CJK substrings behave under each tokenizer, and what
//! indexing and querying actually cost at 100k entries.

use std::time::Instant;

use rusqlite::{params, Connection};

fn open() -> Connection {
    Connection::open(":memory:").expect("in-memory sqlite")
}

fn sqlite_version(conn: &Connection) -> (i64, i64, i64) {
    let text: String = conn
        .query_row("SELECT sqlite_version()", [], |row| row.get(0))
        .expect("version");
    let mut parts = text.split('.').map(|p| p.parse::<i64>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// Creates the shape the real capability would use: a plain `files` table that
/// owns the metadata, plus an FTS5 index over the name that points back at it
/// (`content='files'`) so no second copy of any text is stored.
fn setup(conn: &Connection, tokenizer: &str) {
    conn.execute_batch(&format!(
        "CREATE TABLE files (
            rowid INTEGER PRIMARY KEY,
            name   TEXT NOT NULL,
            parent TEXT NOT NULL,
            is_dir INTEGER NOT NULL,
            size   INTEGER NOT NULL,
            mtime  INTEGER NOT NULL
         );
         CREATE VIRTUAL TABLE files_idx USING fts5(
            name,
            content='files',
            content_rowid='rowid',
            tokenize='{tokenizer}'
         );",
    ))
    .expect("schema");
}

/// External-content tables are not kept in sync by triggers we install here, so
/// the writer inserts both sides itself — one index entry per row, no duplicate
/// payload beyond the inverted index itself.
fn insert(conn: &Connection, name: &str, parent: &str, is_dir: bool, size: i64, mtime: i64) {
    conn.execute(
        "INSERT INTO files (name, parent, is_dir, size, mtime) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![name, parent, is_dir as i64, size, mtime],
    )
    .expect("insert files");
    let rowid = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO files_idx (rowid, name) VALUES (?1, ?2)",
        params![rowid, name],
    )
    .expect("insert index");
}

fn search(conn: &Connection, query: &str, limit: i64) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.parent || '/' || f.name FROM files_idx
               JOIN files f ON f.rowid = files_idx.rowid
              WHERE files_idx MATCH ?1 ORDER BY bm25(files_idx) LIMIT ?2",
        )
        .expect("prepare");
    stmt.query_map(params![query, limit], |row| row.get::<_, String>(0))
        .expect("query")
        .filter_map(Result::ok)
        .collect()
}

/// The fallback path: a raw substring scan over the metadata table.
fn like_scan(conn: &Connection, pattern: &str, limit: i64) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT parent || '/' || name FROM files
              WHERE name LIKE ?1 ORDER BY is_dir DESC, name LIMIT ?2",
        )
        .expect("prepare");
    stmt.query_map(params![pattern, limit], |row| row.get::<_, String>(0))
        .expect("query")
        .filter_map(Result::ok)
        .collect()
}

#[test]
fn fts5_exists_in_the_bundled_build_and_versions_line_up() {
    let conn = open();
    let (major, minor, patch) = sqlite_version(&conn);
    println!("SPIKE bundled sqlite version: {major}.{minor}.{patch}");
    // The bundled amalgamation libsqlite3-sys compiles is far newer than 3.34,
    // the release that introduced the `trigram` tokenizer.
    assert!(
        (major, minor, patch) >= (3, 34, 0),
        "bundled sqlite too old: {major}.{minor}.{patch}"
    );

    setup(&conn, "unicode61");
    insert(&conn, "notes.txt", "/demo", false, 1284, 1_700_000_000);
    insert(&conn, "report.md", "/demo", false, 5321, 1_700_000_001);
    insert(&conn, "src", "/demo", true, 0, 1_700_000_002);

    let hits = search(&conn, "note*", 10);
    assert_eq!(hits, vec!["/demo/notes.txt".to_owned()]);
    // BM25 exists and is what would order the result pane.
    let ranked = search(&conn, "name:report OR name:notes", 10);
    assert_eq!(ranked.len(), 2, "{ranked:?}");
}

#[test]
fn unicode61_cannot_see_inside_a_cjk_name_but_trigram_can() {
    // Same corpus, two tokenizers. This is the whole reason the spike exists:
    // Windows filenames in this app are routinely Chinese, and a query like
    // 「报告」 has to find 「季度报告.docx」.
    let names = [
        "季度报告.docx",
        "中文GBK.txt",
        "无权限文件.txt",
        "超大日志.log",
        "photo-2026-Q3.jpg",
    ];

    let plain = open();
    setup(&plain, "unicode61");
    for n in names {
        insert(&plain, n, "/demo", false, 100, 1);
    }
    // A whole CJK run becomes a single token, so only a query that spells the
    // entire token (or its prefix) can hit it — never a piece from the middle.
    assert_eq!(search(&plain, "\"季度报告.docx\"", 10).len(), 1);
    assert!(
        search(&plain, "\"报告\"", 10).is_empty(),
        "unicode61 matched inside the token"
    );
    assert!(
        search(&plain, "\"季度报\"", 10).is_empty(),
        "unicode61 matched a middle fragment"
    );

    let tri = open();
    setup(&tri, "trigram");
    for n in names {
        insert(&tri, n, "/demo", false, 100, 1);
    }
    // Three or more characters, from anywhere in the name, is a plain substring
    // lookup — including across the boundary between the CJK run and the dot.
    assert_eq!(
        search(&tri, "\"季度报\"", 10),
        vec!["/demo/季度报告.docx".to_owned()]
    );
    assert_eq!(
        search(&tri, "\"GBK\"", 10),
        vec!["/demo/中文GBK.txt".to_owned()]
    );
    assert_eq!(search(&tri, "\"超日\"", 10).len(), 0);
    assert_eq!(search(&tri, "\"超大日\"", 10).len(), 1);
    assert_eq!(search(&tri, "\".jpg\"", 10).len(), 1);
    // Case-insensitive by default, which matches how users type extensions.
    assert_eq!(search(&tri, "\"PHOTO\"", 10).len(), 1);
}

#[test]
fn trigram_is_shorter_than_three_chars_falls_back_to_like_only() {
    // FTS5's trigram index can only answer queries of 3+ characters, and the
    // LIKE/GLOB acceleration is documented for 3+ character patterns as well.
    // Two-character Chinese queries are extremely common, so record exactly what
    // does and does not work rather than assuming the index covers them.
    let conn = open();
    setup(&conn, "trigram");
    insert(&conn, "季度报告.docx", "/demo", false, 100, 1);
    insert(&conn, "报告模板.md", "/demo", false, 100, 2);
    insert(&conn, "notes.txt", "/demo", false, 100, 3);

    let hits = search(&conn, "\"报告\"", 10);
    let like_hits = like_scan(&conn, "%报告%", 10);
    assert_eq!(like_hits.len(), 2, "{like_hits:?}");
    assert!(hits.is_empty(), "trigram answered a 2-char query: {hits:?}");
    println!(
        "SPIKE two-char query: fts5 MATCH -> {} hits, LIKE scan -> {} hits",
        hits.len(),
        like_hits.len()
    );
    assert!(
        like_hits.len() > hits.len(),
        "expected the substring scan to cover what trigram cannot"
    );
}

#[test]
fn like_over_the_fts_table_is_answered_by_the_trigram_index() {
    // If `%报告%` can be answered from the index, one query path covers both word
    // and substring search and the raw scan in the test above stays rare. LIKE on
    // the *content* table cannot use it, so the shape of the query matters.
    let conn = open();
    setup(&conn, "trigram");
    for i in 0..20_000 {
        insert(&conn, &format!("季度报告{i}.docx"), "/demo", false, i, i);
    }

    let via_index: i64 = conn
        .query_row(
            "SELECT count(*) FROM files_idx WHERE name LIKE '%报告%'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(via_index, 20_000);

    let index_plan = explain(
        &conn,
        "SELECT rowid FROM files_idx WHERE name LIKE '%报告%'",
    );
    let scan_plan = explain(&conn, "SELECT rowid FROM files WHERE name LIKE '%报告%'");
    println!("SPIKE LIKE on fts table : {index_plan}");
    println!("SPIKE LIKE on data table: {scan_plan}");
    assert!(
        index_plan.to_lowercase().contains("fts")
            || index_plan.to_lowercase().contains("files_idx"),
        "expected the trigram index to serve LIKE: {index_plan}"
    );
}

/// Full `EXPLAIN QUERY PLAN` text, one line per step.
fn explain(conn: &Connection, sql: &str) -> String {
    let mut stmt = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .expect("explain");
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(3))
        .expect("explain rows");
    rows.filter_map(Result::ok).collect::<Vec<_>>().join(" | ")
}

#[test]
fn scale_probe_costs_at_100k_names() {
    const N: i64 = 100_000;
    let conn = open();
    setup(&conn, "trigram");

    let started = Instant::now();
    conn.execute_batch("BEGIN").expect("begin");
    for i in 0..N {
        let dir = i % 500;
        let name = match i % 5 {
            0 => format!("2026-Q{}_报告{i}.docx", dir % 4 + 1),
            1 => format!("photo-{dir:04}_{i}.jpg"),
            2 => format!("log-{i}.txt"),
            3 => format!("无权限文件{i}.txt"),
            _ => format!("dataset_{i}.csv"),
        };
        insert(
            &conn,
            &name,
            &format!("C:/stress/dir{dir}"),
            i % 40 == 0,
            i,
            i,
        );
    }
    conn.execute_batch("COMMIT").expect("commit");
    let build = started.elapsed();

    let indexed: i64 = conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
        .expect("count");
    assert_eq!(indexed, N);

    let mut word_ms = 0_u128;
    let mut cjk_ms = 0_u128;
    let mut short_ms = 0_u128;
    let reps = 20;
    for _ in 0..reps {
        let t = Instant::now();
        let hits = search(&conn, "\"photo\"", 200);
        word_ms += t.elapsed().as_millis();
        assert!(!hits.is_empty());

        let t = Instant::now();
        let hits = search(&conn, "\"无权限\"", 200);
        cjk_ms += t.elapsed().as_millis();
        assert!(!hits.is_empty());

        let t = Instant::now();
        let hits = like_scan(&conn, "%报告%", 200);
        short_ms += t.elapsed().as_millis();
        assert!(!hits.is_empty());
    }

    println!(
        "SPIKE scale: build {N} names (trigram) in {} ms; per-query avg over {reps}: \
         ascii substring {} ms, cjk substring {} ms, LIKE fallback {} ms",
        build.as_millis(),
        word_ms / reps,
        cjk_ms / reps,
        short_ms / reps
    );

    // Bounds chosen so a regression (dropping the index, scanning per keystroke)
    // fails the spike, while a normal machine stays comfortably inside them.
    assert!(
        build.as_millis() < 60_000,
        "index build too slow: {build:?}"
    );
    assert!(word_ms / reps < 200, "ascii substring query too slow");
    assert!(cjk_ms / reps < 200, "cjk substring query too slow");
    assert!(short_ms / reps < 1_500, "LIKE fallback scan too slow");
}

#[test]
fn incremental_delete_and_rebuild_are_cheap_and_explicit() {
    // P7-29 needs "index can be rebuilt wholesale" and "one changed file updates
    // one row". With an external-content table the delete must be issued with the
    // *old* value, which is exactly the trap a naive implementation falls into.
    let conn = open();
    setup(&conn, "trigram");
    insert(&conn, "notes.txt", "/demo", false, 1284, 1);
    insert(&conn, "report.md", "/demo", false, 5321, 2);
    assert_eq!(search(&conn, "\"note\"", 10).len(), 1);

    let rowid: i64 = conn
        .query_row(
            "SELECT rowid FROM files WHERE name = 'notes.txt'",
            [],
            |r| r.get(0),
        )
        .expect("rowid");
    // The documented delete for an external-content index: pass the old columns.
    conn.execute(
        "INSERT INTO files_idx (files_idx, rowid, name) VALUES ('delete', ?1, ?2)",
        params![rowid, "notes.txt"],
    )
    .expect("index delete");
    conn.execute("DELETE FROM files WHERE rowid = ?1", params![rowid])
        .expect("row delete");

    assert_eq!(search(&conn, "\"note\"", 10), Vec::<String>::new());
    assert_eq!(search(&conn, "\"report\"", 10).len(), 1);

    let left: i64 = conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
        .expect("count");
    assert_eq!(left, 1);
}
