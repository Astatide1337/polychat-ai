//! POST/DELETE /v1/sessions/:provider — mirrors `src/server/routes/sessions.ts`

use axum::extract::Path;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::config::{get_api_key, load_config, PROVIDERS};
use crate::router::{Providers, SharedModelRegistry};
use crate::routes::model_registry::ModelRegistry;
use crate::session::{
    delete_session, has_session, normalize_storage_state, save_session, unseal_transport_envelope,
    TransportEnvelope,
};

// Rate limiting state
use std::sync::Mutex;
use std::time::Instant;

struct PushRecord {
    count: u32,
    window_start: Instant,
}

static PUSH_RATES: std::sync::LazyLock<Mutex<HashMap<String, PushRecord>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

const PUSH_LIMIT: u32 = 5;
const PUSH_WINDOW_SECS: u64 = 3600;

fn check_rate_limit(api_key: &str) -> bool {
    let mut rates = PUSH_RATES.lock().unwrap();
    let now = Instant::now();
    let record = rates.get_mut(api_key);
    match record {
        Some(r) if now.duration_since(r.window_start).as_secs() > PUSH_WINDOW_SECS => {
            r.count = 1;
            r.window_start = now;
            true
        }
        Some(r) if r.count >= PUSH_LIMIT => false,
        Some(r) => {
            r.count += 1;
            true
        }
        None => {
            rates.insert(
                api_key.to_string(),
                PushRecord {
                    count: 1,
                    window_start: now,
                },
            );
            true
        }
    }
}

pub async fn push_session_handler(
    Path(provider): Path<String>,
    Json(envelope): Json<TransportEnvelope>,
    providers: Providers,
    registry: SharedModelRegistry,
) -> (StatusCode, Json<Value>) {
    // Validate provider
    let valid_provider = PROVIDERS.iter().any(|(id, _, _)| *id == provider);
    if !valid_provider {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "message": format!("Unknown provider \"{}\"", provider),
                    "type": "invalid_request_error",
                    "code": "unknown_provider"
                }
            })),
        );
    }

    let api_key = match get_api_key() {
        Some(k) => k,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "error": {
                        "message": "Server is not configured to accept session pushes (POLYCHAT_API_KEY not set)",
                        "type": "configuration_error",
                        "code": "no_api_key"
                    }
                })),
            );
        }
    };

    if !check_rate_limit(&api_key) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": {
                    "message": "Too many session pushes. Maximum 5 per hour.",
                    "type": "rate_limit_error",
                    "code": "session_push_rate_limited"
                }
            })),
        );
    }

    // Validate envelope
    if envelope.v != 1 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "message": "Invalid envelope format. Expected v1 transport envelope.",
                    "type": "invalid_request_error",
                    "code": "invalid_envelope"
                }
            })),
        );
    }

    if envelope.provider != provider {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "message": format!("Envelope provider \"{}\" does not match URL provider \"{}\"", envelope.provider, provider),
                    "type": "invalid_request_error",
                    "code": "provider_mismatch"
                }
            })),
        );
    }

    // Check envelope age (1 hour max)
    if let Ok(created) = chrono::DateTime::parse_from_rfc3339(&envelope.created_at) {
        let age = chrono::Utc::now() - created.with_timezone(&chrono::Utc);
        if age.num_seconds() > 3600 {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": {
                        "message": "Envelope has expired. Generate a new one with polychat session push.",
                        "type": "invalid_request_error",
                        "code": "envelope_expired"
                    }
                })),
            );
        }
    }

    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": {
                        "message": format!("Failed to load config: {}", e),
                        "type": "server_error",
                        "code": "config_error"
                    }
                })),
            );
        }
    };

    // Unseal
    let session_json = match unseal_transport_envelope(&envelope, &api_key, &config.session_salt) {
        Ok(j) => j,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": {
                        "message": "Failed to decrypt session envelope. Check that --api-key matches the server's POLYCHAT_API_KEY.",
                        "type": "invalid_request_error",
                        "code": "decryption_failed"
                    }
                })),
            );
        }
    };

    // Parse and validate
    let mut session: Value = match serde_json::from_str(&session_json) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": {
                        "message": "Session payload is not valid JSON.",
                        "type": "invalid_request_error",
                        "code": "invalid_session_json"
                    }
                })),
            );
        }
    };

    let has_cookies = session
        .get("cookies")
        .and_then(|c| c.as_array())
        .map_or(false, |a| !a.is_empty());
    let has_origins = session
        .get("origins")
        .and_then(|o| o.as_array())
        .map_or(false, |a| !a.is_empty());
    let has_user_token = session
        .get("userToken")
        .and_then(|v| v.as_str())
        .map_or(false, |s| !s.is_empty());

    if !has_cookies && !has_origins && !has_user_token {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "message": "Session payload is empty. Log in first and then push the session.",
                    "type": "invalid_request_error",
                    "code": "empty_session"
                }
            })),
        );
    }

    // Normalize and store
    normalize_storage_state(&mut session);
    if let Err(e) = save_session(&provider, &session) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": {
                    "message": format!("Failed to store session: {}", e),
                    "type": "server_error",
                    "code": "session_store_failed"
                }
            })),
        );
    }

    // Refresh the model registry to pick up the newly connected provider
    let new_registry = ModelRegistry::build(&providers).await;
    let new_count = new_registry.len();
    {
        let mut guard = registry.write().await;
        *guard = new_registry;
    }
    tracing::info!(
        "Model registry refreshed after session push: {} models",
        new_count
    );

    (
        StatusCode::OK,
        Json(json!({
            "provider": provider,
            "status": "stored",
            "message": format!("Session for \"{}\" stored successfully.", provider),
        })),
    )
}

pub async fn delete_session_handler(
    Path(provider): Path<String>,
    providers: Providers,
    registry: SharedModelRegistry,
) -> (StatusCode, Json<Value>) {
    let valid_provider = PROVIDERS.iter().any(|(id, _, _)| *id == provider);
    if !valid_provider {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "message": format!("Unknown provider \"{}\"", provider),
                    "type": "invalid_request_error",
                    "code": "unknown_provider"
                }
            })),
        );
    }

    if !has_session(&provider) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": {
                    "message": format!("No session found for \"{}\"", provider),
                    "type": "not_found_error",
                    "code": "session_not_found"
                }
            })),
        );
    }

    delete_session(&provider);

    let new_registry = ModelRegistry::build(&providers).await;
    let new_count = new_registry.len();
    {
        let mut guard = registry.write().await;
        *guard = new_registry;
    }
    tracing::info!(
        "Model registry refreshed after session delete: {} models",
        new_count
    );

    (
        StatusCode::OK,
        Json(json!({
            "provider": provider,
            "status": "deleted",
        })),
    )
}
