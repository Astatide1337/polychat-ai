//! Axum router assembly.

use axum::Router;
use axum::routing::{get, post, delete};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::CorsLayer;
use tower_http::timeout::TimeoutLayer;

use crate::auth::auth_middleware;
use crate::providers::Provider;
use crate::routes::*;

pub fn build_router(providers: Arc<HashMap<String, Arc<dyn Provider>>>) -> Router {
    let p_health = providers.clone();
    let p_models = providers.clone();
    let p_models_get = providers.clone();
    let p_completions = providers.clone();
    let p_conversations = providers.clone();
    let p_create_convo = providers.clone();
    let p_generate = providers.clone();

    Router::new()
        .route("/health", get(move || health::health_handler(p_health.clone())))
        .route("/v1/models", get(move || models::list_models_handler(p_models.clone())))
        .route("/v1/models/{model_id}", get(
            move |path: axum::extract::Path<String>| {
                let p = p_models_get.clone();
                async move { models::get_model_handler(path, p).await }
            }
        ))
        .route("/v1/chat/completions", post(move |body: axum::Json<completions::CompletionRequest>| {
            let p = p_completions.clone();
            async move { completions::completions_handler(body, p).await }
        }))
        .route("/v1/conversations", get(move |query: axum::extract::Query<conversations::ConversationsQuery>| {
            let p = p_conversations.clone();
            async move { conversations::list_conversations_handler(query, p).await }
        }))
        .route("/v1/conversations", post(move |body: axum::Json<conversations::CreateConversationBody>| {
            let p = p_create_convo.clone();
            async move { conversations::create_conversation_handler(body, p).await }
        }))
        .route("/v1/sessions/{provider}", post(sessions::push_session_handler))
        .route("/v1/sessions/{provider}", delete(sessions::delete_session_handler))
        .route("/api/generate", post(move |body: axum::Json<generate::GenerateRequest>| {
            let p = p_generate.clone();
            async move { generate::generate_handler(body, p).await }
        }))
        .layer(axum::middleware::from_fn(auth_middleware))
        .layer(TimeoutLayer::new(Duration::from_secs(120)))
        .layer(CorsLayer::permissive())
}
