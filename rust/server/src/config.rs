//! Configuration loading — mirrors `src/config/index.ts`
//!
//! Reads `~/.polychat/config.json` and `~/.polychat/.env`.

use anyhow::{bail, Context};
use hex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub default_model: String,
    pub connected: bool,
    #[serde(default)]
    pub last_validated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub port: u16,
    pub host: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolychatConfig {
    pub default_model: String,
    pub server: ServerConfig,
    pub session_salt: String,
    pub providers: std::collections::HashMap<String, ProviderConfig>,
}

// ---------------------------------------------------------------------------
// Provider defaults
// ---------------------------------------------------------------------------

pub const PROVIDERS: &[(&str, &str, &str)] = &[
    ("chatgpt", "ChatGPT", "gpt-5-5"),
    ("claude", "Claude", "claude-sonnet-4-6"),
    ("deepseek", "DeepSeek", "deepseek-v4-flash"),
    ("gemini", "Gemini", "gemini-2.5-flash"),
    ("kimi", "Kimi", "kimi"),
];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

pub fn config_dir() -> PathBuf {
    PathBuf::from(env::var("HOME").unwrap_or_else(|_| "/tmp".into())).join(".polychat")
}

pub fn session_dir() -> PathBuf {
    config_dir().join("sessions")
}

pub fn config_file() -> PathBuf {
    config_dir().join("config.json")
}

pub fn env_file() -> PathBuf {
    config_dir().join(".env")
}

// ---------------------------------------------------------------------------
// .env loading
// ---------------------------------------------------------------------------

/// Load `~/.polychat/.env` into the process environment.
/// Shell environment wins over file values (only sets if not already present).
pub fn load_dot_env() {
    let path = env_file();
    let contents = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return,
    };
    for raw in contents.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(eq) = line.find('=') {
            let key = line[..eq].trim();
            let val = line[eq + 1..].trim();
            // Strip surrounding quotes
            let val = if (val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\''))
            {
                &val[1..val.len() - 1]
            } else {
                val
            };
            if !key.is_empty() && env::var(key).is_err() {
                env::set_var(key, val);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

pub fn load_config() -> anyhow::Result<PolychatConfig> {
    let dir = config_dir();
    fs::create_dir_all(dir.join("sessions")).context("creating session dir")?;

    let path = config_file();
    if !path.exists() {
        let config = default_config();
        save_config(&config)?;
        return Ok(config);
    }

    let raw = fs::read_to_string(&path).context("reading config.json")?;
    let mut config: PolychatConfig = serde_json::from_str(&raw).context("parsing config.json")?;
    let mut changed = normalize_config(&mut config);

    // Migrate legacy default model names
    let legacy: &[(&str, &str)] = &[
        ("chatgpt", "gpt-4o"),
        ("chatgpt", "gpt-4.1-mini"),
        ("chatgpt", "gpt-5-mini"),
        ("deepseek", "deepseek-v4"),
    ];
    for (pid, old_default) in legacy {
        if let Some(pc) = config.providers.get(*pid) {
            if pc.default_model == *old_default {
                if let Some((_, _, new_default)) = PROVIDERS.iter().find(|(p, _, _)| p == pid) {
                    config.providers.get_mut(*pid).unwrap().default_model = new_default.to_string();
                    changed = true;
                }
            }
        }
    }
    if changed {
        save_config(&config)?;
    }

    Ok(config)
}

pub fn save_config(config: &PolychatConfig) -> anyhow::Result<()> {
    let dir = config_dir();
    fs::create_dir_all(&dir).context("creating config dir")?;
    let json = format!("{}\n", serde_json::to_string_pretty(config)?);
    let temp_path = dir.join(format!("config.json.{}.tmp", std::process::id()));
    fs::write(&temp_path, json)?;
    fs::rename(temp_path, config_file())?;
    Ok(())
}

fn normalize_config(config: &mut PolychatConfig) -> bool {
    let mut changed = false;
    let known: HashMap<&str, &str> = PROVIDERS
        .iter()
        .map(|(id, _, model)| (*id, *model))
        .collect();

    if config.default_model.trim().is_empty() {
        config.default_model = "claude-sonnet-4-6".into();
        changed = true;
    }

    for (provider_id, _provider_name, default_model) in PROVIDERS {
        match config.providers.get_mut(*provider_id) {
            Some(provider) => {
                if provider.default_model.trim().is_empty() {
                    provider.default_model = (*default_model).to_string();
                    changed = true;
                }
            }
            None => {
                config.providers.insert(
                    (*provider_id).to_string(),
                    ProviderConfig {
                        default_model: (*default_model).to_string(),
                        connected: false,
                        last_validated: None,
                    },
                );
                changed = true;
            }
        }
    }

    let before = config.providers.len();
    config
        .providers
        .retain(|provider_id, _| known.contains_key(provider_id.as_str()));
    if config.providers.len() != before {
        changed = true;
    }

    changed
}

fn default_config() -> PolychatConfig {
    use rand::RngCore;
    let mut salt = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let session_salt = hex::encode(salt);

    let mut providers = std::collections::HashMap::new();
    for (id, _name, default_model) in PROVIDERS {
        providers.insert(
            id.to_string(),
            ProviderConfig {
                default_model: default_model.to_string(),
                connected: false,
                last_validated: None,
            },
        );
    }

    PolychatConfig {
        default_model: "claude-sonnet-4-6".into(),
        server: ServerConfig {
            port: 1443,
            host: "127.0.0.1".into(),
        },
        session_salt,
        providers,
    }
}

// ---------------------------------------------------------------------------
// Required env vars
// ---------------------------------------------------------------------------

pub fn get_secret_key() -> anyhow::Result<String> {
    let key = env::var("POLYCHAT_SECRET_KEY")
        .context("POLYCHAT_SECRET_KEY is not set. Generate one with: openssl rand -hex 32")?;
    let key = key.trim().to_string();
    if key.len() < 32 {
        bail!(
            "POLYCHAT_SECRET_KEY is too short ({} chars). Must be at least 32 characters.",
            key.len()
        );
    }
    Ok(key)
}

pub fn get_api_key() -> Option<String> {
    env::var("POLYCHAT_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}
