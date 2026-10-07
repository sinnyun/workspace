//! Concrete `hash` capability. Streams files in fixed chunks so hashing a large
//! file stays memory-bounded and can be parallelised later (roadmap P1-7, R7).

use std::fs::File;
use std::io::Read;

use blake3::Hasher as Blake3;
use sha2::{Digest, Sha256};

use fm_contracts::capability::{CapabilityError, HashAlgo, HashApi};

const CHUNK: usize = 256 * 1024;

/// Streaming blake3/sha256 implementation of [`HashApi`].
pub struct StreamingHash;

impl HashApi for StreamingHash {
    fn file(&self, path: &str, algo: HashAlgo) -> Result<String, CapabilityError> {
        let mut file = File::open(path).map_err(CapabilityError::from_io)?;
        let mut buf = vec![0u8; CHUNK];
        match algo {
            HashAlgo::Blake3 => {
                let mut h = Blake3::new();
                loop {
                    let n = file.read(&mut buf).map_err(CapabilityError::from_io)?;
                    if n == 0 {
                        break;
                    }
                    h.update(&buf[..n]);
                }
                Ok(h.finalize().to_hex().to_string())
            }
            HashAlgo::Sha256 => {
                let mut h = Sha256::new();
                loop {
                    let n = file.read(&mut buf).map_err(CapabilityError::from_io)?;
                    if n == 0 {
                        break;
                    }
                    h.update(&buf[..n]);
                }
                Ok(hex(&h.finalize()))
            }
        }
    }

    fn bytes(&self, data: &[u8], algo: HashAlgo) -> String {
        match algo {
            HashAlgo::Blake3 => blake3::hash(data).to_hex().to_string(),
            HashAlgo::Sha256 => {
                let mut h = Sha256::new();
                h.update(data);
                hex(&h.finalize())
            }
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}
