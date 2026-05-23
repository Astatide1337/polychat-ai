//! Axum router assembly.

use axum::Router;
use axum::routing::{get, post, delete};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot::Sender;
use tower_http::cors::CorsLayer;
use tower_http::timeout::TimeoutLayer;

use crate::auth::auth_middleware;
use crate::config::PolychatConfig;
use crate::providers::Provider;
use crate::routes::*;
use crate::routes::shutdown::ShutdownState;

pub fn build_router(
    providers: Arc<HashMap<String, Arc<dyn Provider>>>,
    config: Arc<PolychatConfig>,
    shutdown_tx: Sender<()>,
) -> Router {
    let p_health = providers.clone();
    let p_models = providers.clone();
    let p_models_get = providers.clone();
    let p_completions = providers.clone();
    let p_conversations = providers.clone();
    let p_create_convo = providers.clone();
    let p_generate = providers.clone();
    let c_completions = config.clone();
    let c_generate = config.clone();

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
            let c = c_completions.clone();
            async move { completions::completions_handler(body, p, c).await }
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
            let c = c_generate.clone();
            async move { generate::generate_handler(body, p, c).await }
        }))
        .route("/shutdown", post(shutdown::shutdown_handler))
        .with_state(ShutdownState { tx: Arc::new(Mutex::new(Some(shutdown_tx))) })
        .layer(axum::middleware::from_fn(auth_middleware))
        .layer(TimeoutLayer::new(Duration::from_secs(120)))
        .layer(CorsLayer::permissive())
}
