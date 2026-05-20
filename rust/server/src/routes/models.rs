//! GET /v1/models and GET /v1/models/:model_id.

use axum::{extract::Path, Json};
use axum::http::StatusCode;
use serde_json::{json, Value};

use crate::routes::errors::RouteError;
use crate::routes::resolver::{Providers, find_model, list_connected_models};

fn serialize_model(model: crate::providers::ModelInfo) -> Value {
    let mut value = json!({
        "id": model.id,
        "name": model.name,
        "object": "model",
        "created": chrono::Utc::now().timestamp(),
        "owned_by": model.provider,
    });
    if let Some(capabilities) = model.capabilities {
        value["capabilities"] = serde_json::to_value(capabilities).expect("serialize model capabilities");
    }
    value
}

pub async fn list_models_handler(
    providers: Providers,
) -> Json<Value> {
    let mut all_models = Vec::new();
    for model in list_connected_models(&providers, 20).await {
        all_models.push(serialize_model(model));
    }

    Json(json!({
        "object": "list",
        "data": all_models,
    }))
}

pub async fn get_model_handler(
    Path(model_id): Path<String>,
    providers: Providers,
) -> (StatusCode, Json<Value>) {
    if let Some(model) = find_model(&model_id, &providers, 20).await {
        return (StatusCode::OK, Json(serialize_model(model)));
    }

    RouteError::new(
        StatusCode::NOT_FOUND,
        format!("Model '{}' not found. Run 'polychat models' to see available models.", model_id),
        "invalid_request_error",
        "model_not_found",
    ).into_json()
}
