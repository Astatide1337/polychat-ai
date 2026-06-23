//! Axum router assembly.

use axum::http::{StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, get_service, post};
use axum::Router;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot::Sender, RwLock};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::timeout::TimeoutLayer;

use crate::auth::auth_middleware;
use crate::config::PolychatConfig;
use crate::providers::Provider;
use crate::routes::model_registry::ModelRegistry;
use crate::routes::shutdown::ShutdownState;
use crate::routes::*;

pub type Providers = Arc<HashMap<String, Arc<dyn Provider>>>;
pub type SharedModelRegistry = Arc<RwLock<ModelRegistry>>;

fn web_dist_dir() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("POLYCHAT_WEB_DIST") {
        let candidate = PathBuf::from(path);
        if candidate.join("index.html").is_file() {
            return Some(candidate);
        }
    }

    let cwd_candidate = PathBuf::from("web-dist");
    if cwd_candidate.join("index.html").is_file() {
        return Some(cwd_candidate);
    }

    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors() {
            let candidate = ancestor.join("web-dist");
            if candidate.join("index.html").is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn is_api_like_path(path: &str) -> bool {
    path.starts_with("/v1/") || path.starts_with("/api/") || path == "/shutdown"
}

async fn spa_or_api_404(uri: Uri, index: PathBuf) -> Response {
    if is_api_like_path(uri.path()) {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({
                "error": {
                    "message": format!("Route not found: {}", uri.path()),
                    "type": "invalid_request_error",
                    "code": "route_not_found"
                }
            })),
        )
            .into_response();
    }

    match tokio::fs::read_to_string(index).await {
        Ok(body) => Html(body).into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Polychat WebUI assets were not found. Run `npm run build:web` before starting the server.",
        )
            .into_response(),
    }
}

pub fn build_router(
    providers: Providers,
    config: Arc<PolychatConfig>,
    registry: SharedModelRegistry,
    shutdown_tx: Sender<()>,
) -> Router {
    let p_health = providers.clone();
    let p_sessions_push = providers.clone();
    let p_sessions_delete = providers.clone();
    let p_conversations = providers.clone();
    let p_create_convo = providers.clone();
    let p_generate = providers.clone();
    let c_completions = config.clone();
    let c_generate = config.clone();

    let r_models = registry.clone();
    let r_models_get = registry.clone();
    let r_completions = registry.clone();
    let r_generate = registry.clone();
    let r_sessions = registry.clone();
    let r_sessions_delete = registry.clone();

    let api_router = Router::new()
        .route(
            "/health",
            get(move || health::health_handler(p_health.clone())),
        )
        .route(
            "/v1/models",
            get(move || models::list_models_handler(r_models.clone())),
        )
        .route(
            "/v1/models/{model_id}",
            get(move |path: axum::extract::Path<String>| {
                let r = r_models_get.clone();
                async move { models::get_model_handler(path, r).await }
            }),
        )
        .route("/v1/mcp/servers", get(mcp::list_mcp_servers_handler))
        .route("/v1/mcp/tools", get(mcp::list_mcp_tools_handler))
        .route("/v1/mcp/tools/:name/call", post(mcp::call_mcp_tool_handler))
        .route(
            "/v1/chat/completions",
            post(move |body: axum::Json<completions::CompletionRequest>| {
                let c = c_completions.clone();
                let r = r_completions.clone();
                async move { completions::completions_handler(body, c, r).await }
            }),
        )
        .route(
            "/v1/conversations",
            get(
                move |query: axum::extract::Query<conversations::ConversationsQuery>| {
                    let p = p_conversations.clone();
                    async move { conversations::list_conversations_handler(query, p).await }
                },
            ),
        )
        .route(
            "/v1/conversations",
            post(
                move |body: axum::Json<conversations::CreateConversationBody>| {
                    let p = p_create_convo.clone();
                    async move { conversations::create_conversation_handler(body, p).await }
                },
            ),
        )
        .route(
            "/v1/sessions/{provider}",
            post(
                move |path: axum::extract::Path<String>,
                      body: axum::Json<crate::session::TransportEnvelope>| {
                    let p = p_sessions_push.clone();
                    let r = r_sessions.clone();
                    async move { sessions::push_session_handler(path, body, p, r).await }
                },
            ),
        )
        .route(
            "/v1/sessions/{provider}",
            delete(move |path: axum::extract::Path<String>| {
                let p = p_sessions_delete.clone();
                let r = r_sessions_delete.clone();
                async move { sessions::delete_session_handler(path, p, r).await }
            }),
        )
        .route(
            "/api/generate",
            post(move |body: axum::Json<generate::GenerateRequest>| {
                let p = p_generate.clone();
                let c = c_generate.clone();
                let r = r_generate.clone();
                async move { generate::generate_handler(body, p, c, r).await }
            }),
        )
        .route("/shutdown", post(shutdown::shutdown_handler))
        .with_state(ShutdownState {
            tx: Arc::new(Mutex::new(Some(shutdown_tx))),
        })
        .layer(axum::middleware::from_fn(auth_middleware))
        .layer(TimeoutLayer::new(Duration::from_secs(120)))
        .layer(CorsLayer::permissive());

    if let Some(web_dist) = web_dist_dir() {
        let index = web_dist.join("index.html");
        api_router
            .route("/", get_service(ServeFile::new(index.clone())))
            .nest_service("/assets", ServeDir::new(web_dist.join("assets")))
            .fallback(move |uri: Uri| spa_or_api_404(uri, index.clone()))
    } else {
        api_router.route(
            "/",
            get(|| async {
                (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "Polychat WebUI assets were not found. Run `npm run build:web` before starting the server.",
                )
            }),
        )
    }
}
