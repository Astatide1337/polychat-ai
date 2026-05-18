//! GET /health route — mirrors `src/server/routes/health.ts`

use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

use crate::config::{get_api_key, load_config, PROVIDERS};
use crate::session::has_session;
use crate::providers::Provider;

pub async fn health_handler(_providers: Arc<HashMap<String, Arc<dyn Provider>>>) -> Json<Value> {
    let _config = load_config().ok(); // Not used, but loaded for side effects

    let api_key = get_api_key();
    let mut result = json!({
        "status": "ok",
        "version": "0.1.0",
    });

    if api_key.is_some() {
        if let Ok(cfg) = load_config() {
            result.as_object_mut().unwrap().insert(
                "session_salt".into(),
                json!(cfg.session_salt),
            );
        }
    }

    let mut provider_map = serde_json::Map::new();
    for (key, _name, default_model) in PROVIDERS {
        let connected = has_session(key);
        let default = if let Ok(cfg) = load_config() {
            cfg.providers.get(&key.to_string()).map(|p| p.default_model.clone())
                .unwrap_or_else(|| default_model.to_string())
        } else {
            default_model.to_string()
        };

        provider_map.insert(key.to_string(), json!({
            "connected": connected,
            "session_valid": if connected { json!(true) } else { json!(null) },
            "defaultModel": default,
        }));
    }

    result.as_object_mut().unwrap().insert("providers".into(), Value::Object(provider_map));
    Json(result)
}
