//! DeepSeek Proof-of-Work solver.
//!
//! Fetches a challenge from the DeepSeek API, solves it using the
//! Keccak-256 implementation, and builds the `x-ds-pow-response` header.

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use base64::Engine;
use hex;

use super::keccak::KeccakSponge;

// ---------------------------------------------------------------------------
// Challenge types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct DeepSeekChallenge {
    pub algorithm: String,
    pub challenge: String,
    pub salt: String,
    pub signature: String,
    pub difficulty: usize,
    pub expire_at: u64,
#[allow(dead_code)]
    pub expire_after: u64,
#[allow(dead_code)]
    pub target_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PowAnswer {
    pub algorithm: String,
    pub challenge: String,
    pub salt: String,
    pub answer: usize,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
struct PowPayload {
    algorithm: String,
    challenge: String,
    salt: String,
    answer: usize,
    signature: String,
    target_path: String,
}

// ---------------------------------------------------------------------------
// Challenge fetch
// ---------------------------------------------------------------------------

/// Fetch a PoW challenge from the DeepSeek API.
pub async fn fetch_challenge(
    client: &reqwest::Client,
    headers: &reqwest::header::HeaderMap,
) -> anyhow::Result<DeepSeekChallenge> {
    let res = client
        .post("https://chat.deepseek.com/api/v0/chat/create_pow_challenge")
        .headers(headers.clone())
        .json(&serde_json::json!({ "target_path": "/api/v0/chat/completion" }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .context("fetching DeepSeek PoW challenge")?;

    if !res.status().is_success() {
        bail!("DeepSeek PoW challenge request failed: {}", res.status());
    }

    let json: serde_json::Value = res.json().await?;
    let challenge = json
        .get("data")
        .and_then(|d| d.get("biz_data"))
        .and_then(|b| b.get("challenge"))
        .context("DeepSeek PoW challenge response missing challenge data")?;

    let chal: DeepSeekChallenge = serde_json::from_value(challenge.clone())
        .context("parsing DeepSeek PoW challenge")?;
    Ok(chal)
}

// ---------------------------------------------------------------------------
// Solve
// ---------------------------------------------------------------------------

/// Solve a DeepSeekHashV1 PoW challenge.
///
/// The algorithm:
/// ```text
/// prefix = "{salt}_{expire_at}_"
/// for nonce in 0..difficulty:
///     digest = keccak256("{prefix}{nonce}")
///     if hex(digest) == challenge:
///         return nonce
/// ```
///
/// Optimization: pre-absorb the constant prefix into the sponge state once,
/// then clone it for each nonce attempt.
pub fn solve_pow(chal: &DeepSeekChallenge) -> anyhow::Result<PowAnswer> {
    let prefix = format!("{}_{}_", chal.salt, chal.expire_at);

    // Pre-absorb the prefix into a base sponge state
    let mut base_sponge = KeccakSponge::new();
    base_sponge.update(prefix.as_bytes());

    for nonce in 0..chal.difficulty {
        let mut sponge = base_sponge.clone();
        let nonce_str = nonce.to_string();
        sponge.update(nonce_str.as_bytes());
        let hash = sponge.finalize();
        let hex_digest = hex::encode(hash);

        if hex_digest == chal.challenge {
            return Ok(PowAnswer {
                algorithm: chal.algorithm.clone(),
                challenge: chal.challenge.clone(),
                salt: chal.salt.clone(),
                answer: nonce,
                signature: chal.signature.clone(),
            });
        }
    }

    bail!(
        "DeepSeek PoW solve failed: no nonce found in 0..{}",
        chal.difficulty
    )
}

// ---------------------------------------------------------------------------
// Header builder
// ---------------------------------------------------------------------------

/// Build the base64-encoded `x-ds-pow-response` header value.
pub fn build_pow_header(answer: &PowAnswer, target_path: &str) -> String {
    let payload = PowPayload {
        algorithm: answer.algorithm.clone(),
        challenge: answer.challenge.clone(),
        salt: answer.salt.clone(),
        answer: answer.answer,
        signature: answer.signature.clone(),
        target_path: target_path.to_string(),
    };
    let json = serde_json::to_string(&payload).unwrap();
    base64::engine::general_purpose::STANDARD.encode(json)
}
