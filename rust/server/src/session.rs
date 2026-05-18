//! Session file encryption/decryption — mirrors `src/session/crypto.ts`
//!
//! Wire format: [16-byte IV][16-byte GCM auth tag][ciphertext]
//! Key derivation: scrypt(password, "polychat-session-key", N=32768, r=8, p=1, dkLen=32)
//!
//! IMPORTANT: Node.js `createCipheriv('aes-256-gcm', key, iv)` with a 16-byte IV
//! uses NIST SP 800-38D variable-length nonce processing. The `aes-gcm` Rust crate
//! supports this via `AesGcm<Aes256, U16>` (16-byte nonce variant).

use aes::cipher::consts::U16;
use aes_gcm::aead::{Aead, KeyInit, OsRng, AeadCore};
use aes_gcm::{AesGcm, Nonce};
use aes::Aes256;
use base64::Engine;
use anyhow::{anyhow, bail, Context};
use scrypt::scrypt as scrypt_derive;
use scrypt::Params;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::config::{get_secret_key, load_config, session_dir};

// AES-256-GCM with 16-byte nonce (matches Node.js's randomBytes(16) IV)
type Aes256GcmN16 = AesGcm<Aes256, U16>;

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

fn scrypt_key(secret: &str, salt: &str) -> anyhow::Result<[u8; 32]> {
    let password = format!("{}:{}", secret, salt);
    let params = Params::new(14, 8, 1, 32).map_err(|e| anyhow!("scrypt params: {}", e))?;
    let mut key = [0u8; 32];
    scrypt_derive(password.as_bytes(), b"polychat-session-key", &params, &mut key)
        .map_err(|e| anyhow!("scrypt derive: {}", e))?;
    Ok(key)
}

pub fn get_encryption_key() -> anyhow::Result<[u8; 32]> {
    let secret = get_secret_key()?;
    let config = load_config()?;
    scrypt_key(&secret, &config.session_salt)
}

pub fn derive_transport_key(api_key: &str, nonce: &str, salt: &str) -> anyhow::Result<[u8; 32]> {
    let secret = format!("transport:{}:{}", api_key, nonce);
    scrypt_key(&secret, salt)
}

// ---------------------------------------------------------------------------
// AES-256-GCM encrypt/decrypt (16-byte nonce, matches Node.js)
// ---------------------------------------------------------------------------

pub fn encrypt(data: &str, key: &[u8; 32]) -> anyhow::Result<Vec<u8>> {
    let cipher = Aes256GcmN16::new_from_slice(key)
        .map_err(|e| anyhow!("cipher init: {}", e))?;

    // Generate 16-byte nonce
    let nonce_bytes = Aes256GcmN16::generate_nonce(&mut OsRng);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext_and_tag = cipher
        .encrypt(nonce, data.as_bytes())
        .map_err(|e| anyhow!("encrypt: {}", e))?;

    // aes-gcm returns [ciphertext][tag(16 bytes)]
    let tag_len = 16;
    if ciphertext_and_tag.len() < tag_len {
        bail!("encrypted output too short");
    }
    let (ct, tag) = ciphertext_and_tag.split_at(ciphertext_and_tag.len() - tag_len);

    // Wire format: [nonce (16)][tag (16)][ciphertext]
    let mut output = Vec::with_capacity(16 + 16 + ct.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(tag);
    output.extend_from_slice(ct);
    Ok(output)
}

pub fn decrypt(encrypted: &[u8], key: &[u8; 32]) -> anyhow::Result<String> {
    if encrypted.len() < 33 {
        bail!("Encrypted data is too short");
    }

    let (nonce_bytes, rest) = encrypted.split_at(16);
    let (tag_bytes, ciphertext) = rest.split_at(16);

    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256GcmN16::new_from_slice(key)
        .map_err(|e| anyhow!("cipher init: {}", e))?;

    // aes-gcm expects [ciphertext][tag]
    let mut combined = Vec::with_capacity(ciphertext.len() + 16);
    combined.extend_from_slice(ciphertext);
    combined.extend_from_slice(tag_bytes);

    let plaintext = cipher
        .decrypt(nonce, combined.as_slice())
        .map_err(|e| anyhow!("decrypt: {}. Wrong POLYCHAT_SECRET_KEY or corrupt file.", e))?;

    String::from_utf8(plaintext).context("decrypted data is not valid UTF-8")
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

pub fn encryption_self_test() -> anyhow::Result<()> {
    let key = get_encryption_key()?;
    let message = "polychat-encryption-self-test";
    let encrypted = encrypt(message, &key)?;
    let decrypted = decrypt(&encrypted, &key)?;
    if decrypted != message {
        bail!("Encryption self-test failed: round-trip mismatch");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Session file store
// ---------------------------------------------------------------------------

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CookieEntry {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default = "default_path")]
    pub path: String,
    #[serde(default)]
    pub expires: f64,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub secure: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
}
#[allow(dead_code)]

fn default_path() -> String { "/".into() }

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalStorageEntry {
    pub name: String,
    pub value: String,
}
#[allow(dead_code)]

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OriginEntry {
    pub origin: String,
    pub local_storage: Vec<LocalStorageEntry>,
}
pub type SessionValue = serde_json::Value;

// ---------------------------------------------------------------------------
// Session kind — distinguishes cookie-based from OAuth sessions
// ---------------------------------------------------------------------------

#[allow(dead_code)]
/// OAuth 2.0 token session (produced by the PKCE login flow).
/// Stored as `{ "type": "oauth", "access_token": "...", "refresh_token": "...", "expires_at": 1234567890 }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthSession {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix epoch seconds at which access_token expires.
    pub expires_at: i64,
}
#[allow(dead_code)]
/// Identifies what kind of session is stored in a `SessionValue`.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionKind {
    /// Standard Playwright StorageState: { cookies, origins }
    CookieSession,
    /// OAuth 2.0 token session: { type: "oauth", access_token, refresh_token, expires_at }
    OAuthSession,
}
#[allow(dead_code)]

/// Returns the kind of session stored in this value.
pub fn session_kind(value: &SessionValue) -> SessionKind {
    if value.get("type").and_then(|t| t.as_str()) == Some("oauth") {
        SessionKind::OAuthSession
    } else {
        SessionKind::CookieSession
    }
}

#[allow(dead_code)]
/// Deserializes an OAuth session from a `SessionValue`, returning None if it is not
/// an OAuth session or if required fields are missing.
pub fn as_oauth_session(value: &SessionValue) -> Option<OAuthSession> {
    if session_kind(value) != SessionKind::OAuthSession { return None; }
    serde_json::from_value(value.clone()).ok()
}

fn session_path(provider: &str) -> PathBuf {
    session_dir().join(format!("{}.enc", provider))
}

pub fn save_session(provider: &str, data: &SessionValue) -> anyhow::Result<()> {
    let key = get_encryption_key()?;
    let payload = serde_json::to_string(data)?;
    let encrypted = encrypt(&payload, &key)?;
    let dir = session_dir();
    fs::create_dir_all(&dir)?;
    fs::write(session_path(provider), encrypted)?;
    Ok(())
}

pub fn load_session(provider: &str) -> anyhow::Result<SessionValue> {
    let path = session_path(provider);
    if !path.exists() {
        bail!("No session file for {}", provider);
    }
    let encrypted = fs::read(&path).context("reading session file")?;
    let key = get_encryption_key()?;
    let plaintext = decrypt(&encrypted, &key)?;
    let value: SessionValue = serde_json::from_str(&plaintext)?;
    Ok(value)
}

pub fn has_session(provider: &str) -> bool {
    session_path(provider).exists()
}

pub fn delete_session(provider: &str) -> bool {
    let path = session_path(provider);
    if path.exists() { fs::remove_file(path).is_ok() } else { false }
}

// ---------------------------------------------------------------------------
// Transport envelope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransportEnvelope {
    pub v: u8,
    pub provider: String,
    pub nonce: String,
    pub created_at: String,
    pub ciphertext: String,
}

pub fn unseal_transport_envelope(
    envelope: &TransportEnvelope,
    api_key: &str,
    salt: &str,
) -> anyhow::Result<String> {
    if envelope.v != 1 {
        bail!("Unsupported envelope version: {}", envelope.v);
    }
    if envelope.provider.is_empty() || envelope.nonce.is_empty() || envelope.ciphertext.is_empty() {
        bail!("Malformed transport envelope");
    }
    let key = derive_transport_key(api_key, &envelope.nonce, salt)?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(&envelope.ciphertext)
        .context("base64 decode of envelope ciphertext")?;
    decrypt(&ciphertext, &key)
}

// ---------------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------------

pub fn safe_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() { return false; }
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let mut result: u8 = 0;
    for i in 0..a.len() {
        result |= a_bytes[i] ^ b_bytes[i];
    }
    result == 0
}

// ---------------------------------------------------------------------------
// Normalize storage state timestamps
// ---------------------------------------------------------------------------

pub fn normalize_storage_state(value: &mut serde_json::Value) {
    if let Some(obj) = value.as_object_mut() {
        if let Some(cookies) = obj.get_mut("cookies").and_then(|c| c.as_array_mut()) {
            for cookie in cookies.iter_mut() {
                if let Some(obj) = cookie.as_object_mut() {
                    if let Some(expires) = obj.get("expires").and_then(|e| e.as_f64()) {
                        if expires > 10_000_000_000.0 {
                            obj.insert(
                                "expires".into(),
                                serde_json::Value::from((expires / 1000.0).floor() as u64),
                            );
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = [0x42u8; 32];
        let encrypted = encrypt("hello world", &key).unwrap();
        let decrypted = decrypt(&encrypted, &key).unwrap();
        assert_eq!(decrypted, "hello world");
    }

    #[test]
    fn test_decrypt_nodejs_output() {
        // This is Node.js aes-256-gcm output with a 16-byte IV
        // Generated with: key = Buffer.alloc(32, 0x42), iv = randomBytes(16)
        // plaintext = "hello"
        // Since we can't reproduce Node.js output deterministically here,
        // we just verify the round-trip works with our own format
        let key = [0x42u8; 32];
        let msg = "polychat-encryption-self-test";
        let enc = encrypt(msg, &key).unwrap();
        let dec = decrypt(&enc, &key).unwrap();
        assert_eq!(dec, msg);
    }
}

#[cfg(test)]
mod nodejs_compat_test {
    use super::*;

    #[test]
    fn test_decrypt_nodejs_deterministic() {
        // Generated by Node.js:
        // key = Buffer.alloc(32, 0x42)
        // iv = Buffer.alloc(16, 0x01)
        // plaintext = "hello"
        // Wire hex: 010101010101010101010101010101011527b58f4535952f08cd2725e05d39d4ab6f73c9c3
        let wire_hex = "010101010101010101010101010101011527b58f4535952f08cd2725e05d39d4ab6f73c9c3";
        let wire = hex::decode(wire_hex).unwrap();
        let key = [0x42u8; 32];

        match decrypt(&wire, &key) {
            Ok(plaintext) => {
                assert_eq!(plaintext, "hello");
                println!("SUCCESS: Node.js GCM 16-byte IV is compatible!");
            }
            Err(e) => {
                panic!("FAILED to decrypt Node.js output: {}. The aes-gcm crate's 16-byte nonce handling differs from Node.js.", e);
            }
        }
    }
}
