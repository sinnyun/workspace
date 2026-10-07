//! Concrete `db` capability: rusqlite (bundled SQLite) in WAL mode.
//!
//! Each logical `store` is an isolated namespace (R6): a `kv` table for
//! put/get/list/delete and a `log` table for ordered append/read_log. Values are
//! opaque JSON text so `contracts` stays schema-free — a plugin owns the meaning
//! of its own store's rows. Writes are serialised through a single mutex-guarded
//! connection (WAL + one writer avoids cross-store lock contention).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, params};

use fm_contracts::capability::{CapabilityError, DbApi};

/// rusqlite-backed [`DbApi`]. Holds one WAL connection behind a mutex.
pub struct SqliteDb {
    conn: Mutex<Connection>,
}

impl SqliteDb {
    /// Open (or create) the database at `path`. Use `":memory:"` for tests.
    pub fn open(path: &str) -> Result<Self, CapabilityError> {
        if path != ":memory:" {
            if let Some(parent) = Path::new(path).parent() {
                std::fs::create_dir_all(parent).map_err(CapabilityError::from_io)?;
            }
        }
        let conn = Connection::open(path).map_err(map_sql)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(map_sql)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS kv (
                store TEXT NOT NULL,
                key   TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (store, key)
             );
             CREATE TABLE IF NOT EXISTS log (
                store TEXT NOT NULL,
                key   TEXT NOT NULL,
                seq   INTEGER NOT NULL,
                value TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS log_order ON log (store, key, seq);",
        )
        .map_err(map_sql)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

fn map_sql(e: rusqlite::Error) -> CapabilityError {
    CapabilityError::Io(e.to_string())
}

fn to_json(text: &str) -> Result<serde_json::Value, CapabilityError> {
    serde_json::from_str(text).map_err(|e| CapabilityError::Io(e.to_string()))
}

impl DbApi for SqliteDb {
    fn put(
        &self,
        store: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), CapabilityError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO kv (store, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(store, key) DO UPDATE SET value = excluded.value",
            params![store, key, value.to_string()],
        )
        .map_err(map_sql)?;
        Ok(())
    }

    fn get(
        &self,
        store: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, CapabilityError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT value FROM kv WHERE store = ?1 AND key = ?2")
            .map_err(map_sql)?;
        let mut rows = stmt.query(params![store, key]).map_err(map_sql)?;
        match rows.next().map_err(map_sql)? {
            Some(row) => Ok(Some(to_json(row.get::<_, String>(0).map_err(map_sql)?.as_str())?)),
            None => Ok(None),
        }
    }

    fn list(
        &self,
        store: &str,
    ) -> Result<Vec<(String, serde_json::Value)>, CapabilityError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT key, value FROM kv WHERE store = ?1 ORDER BY key")
            .map_err(map_sql)?;
        let mut rows = stmt.query(params![store]).map_err(map_sql)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(map_sql)? {
            let k: String = row.get(0).map_err(map_sql)?;
            let v: String = row.get(1).map_err(map_sql)?;
            out.push((k, to_json(&v)?));
        }
        Ok(out)
    }

    fn append(
        &self,
        store: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), CapabilityError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO log (store, key, seq, value)
             VALUES (?1, ?2, COALESCE((SELECT MAX(seq) FROM log WHERE store = ?1 AND key = ?2), -1) + 1, ?3)",
            params![store, key, value.to_string()],
        )
        .map_err(map_sql)?;
        Ok(())
    }

    fn read_log(
        &self,
        store: &str,
        key: &str,
    ) -> Result<Vec<serde_json::Value>, CapabilityError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT value FROM log WHERE store = ?1 AND key = ?2 ORDER BY seq")
            .map_err(map_sql)?;
        let mut rows = stmt.query(params![store, key]).map_err(map_sql)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(map_sql)? {
            let v: String = row.get(0).map_err(map_sql)?;
            out.push(to_json(&v)?);
        }
        Ok(out)
    }

    fn delete(&self, store: &str, key: &str) -> Result<(), CapabilityError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM kv WHERE store = ?1 AND key = ?2",
            params![store, key],
        )
        .map_err(map_sql)?;
        Ok(())
    }
}
