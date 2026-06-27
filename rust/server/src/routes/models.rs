//! GET /v1/models and GET /v1/models/:model_id.

use axum::extract::Path;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::routes::errors::RouteError;
use crate::routes::model_registry::ModelRegistry;

fn serialize_model(model: crate::providers::ModelInfo) -> Value {
    let mut value = json!({
        "id": model.id,
        "name": model.name,
        "object": "model",
        "created": chrono::Utc::now().timestamp(),
        "owned_by": model.provider,
    });
    if let Some(capabilities) = model.capabilities {
        value["capabilities"] =
            serde_json::to_value(capabilities).expect("serialize model capabilities");
    }
    value
}

pub async fn list_models_handler(registry: Arc<RwLock<ModelRegistry>>) -> Json<Value> {
    let registry = registry.read().await;
    let mut all_models = Vec::new();
    for model in registry.list_models() {
        all_models.push(serialize_model(model));
    }
    Json(json!({
        "object": "list",
        "data": all_models,
    }))
}

pub async fn get_model_handler(
    Path(model_id): Path<String>,
    registry: Arc<RwLock<ModelRegistry>>,
) -> (StatusCode, Json<Value>) {
    let registry = registry.read().await;
    if let Some(model) = registry.find_model(&model_id) {
        return (StatusCode::OK, Json(serialize_model(model)));
    }
    RouteError::new(
        StatusCode::NOT_FOUND,
        format!(
            "Model '{}' not found. Run 'polychat models' to see available models.",
            model_id
        ),
        "invalid_request_error",
        "model_not_found",
    )
    .into_json()
}
