//! GET/POST /v1/conversations and GET /v1/conversations/:provider/:id/messages
//! Mirrors `src/server/routes/conversations.ts`

use axum::extract::Query;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

use crate::providers::Provider;
use crate::session::has_session;

#[derive(Deserialize)]
pub struct ConversationsQuery {
    pub provider: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateConversationBody {
    pub provider: String,
    pub model: String,
}

pub async fn list_conversations_handler(
    Query(query): Query<ConversationsQuery>,
    providers: Arc<HashMap<String, Arc<dyn Provider>>>,
) -> (StatusCode, Json<Value>) {
    let provider_id = match &query.provider {
        Some(p) if !p.is_empty() => p.as_str(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": { "message": "Missing provider", "type": "invalid_request_error", "code": "missing_provider" }
                })),
            );
        }
    };

    let provider = match providers.get(provider_id) {
        Some(p) => p,
        None => {
            return (
                StatusCode::OK,
                Json(json!({
                    "provider": provider_id,
                    "supported": false,
                    "reason": format!("{} is not a known provider.", provider_id),
                })),
            );
        }
    };

    if !has_session(provider_id) {
        return (
            StatusCode::OK,
            Json(json!({
                "provider": provider_id,
                "supported": false,
                "reason": format!("{} is not connected.", provider.name()),
            })),
        );
    }

    if !provider.validate_session().await {
        return (
            StatusCode::OK,
            Json(json!({
                "provider": provider_id,
                "supported": false,
                "reason": format!("{} session has expired.", provider.name()),
            })),
        );
    }

    match provider.list_conversations().await {
        Ok(conversations) => {
            let convos: Vec<Value> = conversations
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id,
                        "provider": c.provider,
                        "title": c.title,
                        "modelId": c.model_id,
                        "updatedAt": c.updated_at,
                        "url": c.url,
                        "providerDebug": c.provider_debug,
                    })
                })
                .collect();
            (
                StatusCode::OK,
                Json(json!({
                    "provider": provider_id,
                    "supported": true,
                    "conversations": convos,
                })),
            )
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": { "message": e.to_string(), "type": "upstream_error", "code": "upstream_error" }
            })),
        ),
    }
}

pub async fn create_conversation_handler(
    Json(body): Json<CreateConversationBody>,
    providers: Arc<HashMap<String, Arc<dyn Provider>>>,
) -> (StatusCode, Json<Value>) {
    let provider = match providers.get(&body.provider) {
        Some(p) => p,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": { "message": "Missing provider or model", "type": "invalid_request_error", "code": "missing_fields" }
                })),
            );
        }
    };

    if !has_session(&body.provider) {
        return (
            StatusCode::OK,
            Json(json!({
                "provider": body.provider,
                "supported": false,
                "reason": format!("{} is not connected.", provider.name()),
            })),
        );
    }

    match provider.create_conversation(&body.model).await {
        Ok(conversation) => {
            if conversation.id.is_empty() {
                return (
                    StatusCode::OK,
                    Json(json!({
                        "provider": body.provider,
                        "supported": false,
                        "reason": format!("{} does not support pre-creating conversations; send a message without provider_conversation_id and a real conversation will be created automatically.", provider.name()),
                    })),
                );
            }
            (
                StatusCode::OK,
                Json(json!({
                    "supported": true,
                    "conversation": {
                        "id": conversation.id,
                        "provider": conversation.provider,
                        "title": conversation.title,
                        "modelId": conversation.model_id,
                        "url": conversation.url,
                        "providerDebug": conversation.provider_debug,
                    }
                })),
            )
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": { "message": e.to_string(), "type": "upstream_error", "code": "upstream_error" }
            })),
        ),
    }
}
