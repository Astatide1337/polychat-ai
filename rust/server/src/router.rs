//! Axum router assembly.

use axum::routing::{delete, get, post};
use axum::Router;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot::Sender, RwLock};
use tower_http::cors::CorsLayer;
use tower_http::timeout::TimeoutLayer;

use crate::auth::auth_middleware;
use crate::config::PolychatConfig;
use crate::providers::Provider;
use crate::routes::model_registry::ModelRegistry;
use crate::routes::shutdown::ShutdownState;
use crate::routes::*;

pub type Providers = Arc<HashMap<String, Arc<dyn Provider>>>;
pub type SharedModelRegistry = Arc<RwLock<ModelRegistry>>;

pub fn build_router(
    providers: Providers,
    config: Arc<PolychatConfig>,
    registry: SharedModelRegistry,
    shutdown_tx: Sender<()>,
) -> Router {
    let h = providers.clone();
    let h_api = providers.clone();
    let h_proxy = providers.clone();
    let sp = providers.clone();
    let sp_api = providers.clone();
    let sp_proxy = providers.clone();
    let sd = providers.clone();
    let sd_api = providers.clone();
    let sd_proxy = providers.clone();
    let cl = providers.clone();
    let cl_api = providers.clone();
    let cl_proxy = providers.clone();
    let cc = providers.clone();
    let cc_api = providers.clone();
    let cc_proxy = providers.clone();
    let pg = providers.clone();
    let cpl = config.clone();
    let _cpl_v1 = config.clone();
    let cpl_nov1 = config.clone();
    let _cpl_api = config.clone();
    let cpl_api_nov1 = config.clone();
    let cpl_api_v1 = config.clone();
    let _cpl_proxy = config.clone();
    let cpl_proxy_nov1 = config.clone();
    let cpl_proxy_v1 = config.clone();
    let cg = config.clone();

    let rm = registry.clone();
    let rm_api = registry.clone();
    let rm_proxy = registry.clone();
    let rm_nov1 = registry.clone();
    let rm_nov1_api = registry.clone();
    let rm_nov1_proxy = registry.clone();
    let rmg = registry.clone();
    let rmg_api = registry.clone();
    let rmg_proxy = registry.clone();
    let rcl = registry.clone();
    let rcl_nov1 = registry.clone();
    let rcl_nov1_api = registry.clone();
    let rcl_nov1_proxy = registry.clone();
    let rcl_api = registry.clone();
    let rcl_proxy = registry.clone();
    let rg = registry.clone();
    let rs = registry.clone();
    let rs_api = registry.clone();
    let rs_proxy = registry.clone();
    let rsd = registry.clone();
    let rsd_api = registry.clone();
    let rsd_proxy = registry.clone();

    Router::new()
        .route("/health", get(move || health::health_handler(h.clone())))
        .route("/api/health", get(move || health::health_handler(h_api.clone())))
        .route("/proxy/polychat/health", get(move || health::health_handler(h_proxy.clone())))
        .route("/v1/models", get(move || models::list_models_handler(rm.clone())))
        .route("/api/v1/models", get(move || models::list_models_handler(rm_api.clone())))
        .route("/proxy/polychat/v1/models", get(move || models::list_models_handler(rm_proxy.clone())))
        .route("/models", get(move || models::list_models_handler(rm_nov1.clone())))
        .route("/api/models", get(move || models::list_models_handler(rm_nov1_api.clone())))
        .route("/proxy/polychat/models", get(move || models::list_models_handler(rm_nov1_proxy.clone())))
        .route("/v1/models/:model_id", get(move |path: axum::extract::Path<String>| {
            let r = rmg.clone();
            async move { models::get_model_handler(path, r).await }
        }))
        .route("/api/v1/models/:model_id", get(move |path: axum::extract::Path<String>| {
            let r = rmg_api.clone();
            async move { models::get_model_handler(path, r).await }
        }))
        .route("/proxy/polychat/v1/models/:model_id", get(move |path: axum::extract::Path<String>| {
            let r = rmg_proxy.clone();
            async move { models::get_model_handler(path, r).await }
        }))
        .route("/v1/mcp/servers", get(mcp::list_mcp_servers_handler))
        .route("/api/v1/mcp/servers", get(mcp::list_mcp_servers_handler))
        .route("/proxy/polychat/v1/mcp/servers", get(mcp::list_mcp_servers_handler))
        .route("/v1/mcp/tools", get(mcp::list_mcp_tools_handler))
        .route("/api/v1/mcp/tools", get(mcp::list_mcp_tools_handler))
        .route("/proxy/polychat/v1/mcp/tools", get(mcp::list_mcp_tools_handler))
        .route("/v1/mcp/tools/:name/call", post(mcp::call_mcp_tool_handler))
        .route("/api/v1/mcp/tools/:name/call", post(mcp::call_mcp_tool_handler))
        .route("/proxy/polychat/v1/mcp/tools/:name/call", post(mcp::call_mcp_tool_handler))
        .route("/v1/chat/completions", post(move |body: axum::Json<completions::CompletionRequest>| {
            let c = cpl.clone();
            let r = rcl.clone();
            async move { completions::completions_handler(body, c, r).await }
        }))
        .route("/chat/completions", post(move |body: axum::Json<completions::CompletionRequest>| {
            let c = cpl_nov1.clone();
            let r = rcl_nov1.clone();
            async move { completions::completions_handler(body, c, r).await }
        }))
        .route("/api/chat/completions", post(move |body: axum::Json<completions::CompletionRequest>| {
            let c = cpl_api_nov1.clone();
            let r = rcl_nov1_api.clone();
            async move { completions::completions_handler(body, c, r).await }
        }))
        .route("/proxy/polychat/chat/completions", post(move |body: axum::Json<completions::CompletionRequest>| {
            let c = cpl_proxy_nov1.clone();
            let r = rcl_nov1_proxy.clone();
            async move { completions::completions_handler(body, c, r).await }
        }))
        .route("/api/v1/chat/completions", post(move |body: axum::Json<completions::CompletionRequest>| {
            let c = cpl_api_v1.clone();
            let r = rcl_api.clone();
            async move { completions::completions_handler(body, c, r).await }
        }))
        .route("/proxy/polychat/v1/chat/completions", post(move |body: axum::Json<completions::CompletionRequest>| {
            let c = cpl_proxy_v1.clone();
            let r = rcl_proxy.clone();
            async move { completions::completions_handler(body, c, r).await }
        }))
        .route("/v1/conversations", get(move |query: axum::extract::Query<conversations::ConversationsQuery>| {
            let p = cl.clone();
            async move { conversations::list_conversations_handler(query, p).await }
        }))
        .route("/api/v1/conversations", get(move |query: axum::extract::Query<conversations::ConversationsQuery>| {
            let p = cl_api.clone();
            async move { conversations::list_conversations_handler(query, p).await }
        }))
        .route("/proxy/polychat/v1/conversations", get(move |query: axum::extract::Query<conversations::ConversationsQuery>| {
            let p = cl_proxy.clone();
            async move { conversations::list_conversations_handler(query, p).await }
        }))
        .route("/v1/conversations", post(move |body: axum::Json<conversations::CreateConversationBody>| {
            let p = cc.clone();
            async move { conversations::create_conversation_handler(body, p).await }
        }))
        .route("/api/v1/conversations", post(move |body: axum::Json<conversations::CreateConversationBody>| {
            let p = cc_api.clone();
            async move { conversations::create_conversation_handler(body, p).await }
        }))
        .route("/proxy/polychat/v1/conversations", post(move |body: axum::Json<conversations::CreateConversationBody>| {
            let p = cc_proxy.clone();
            async move { conversations::create_conversation_handler(body, p).await }
        }))
        .route("/v1/sessions/:provider", post(move |path: axum::extract::Path<String>, body: axum::Json<serde_json::Value>| {
            let p = sp.clone();
            let r = rs.clone();
            async move { sessions::push_session_handler(path, body, p, r).await }
        }))
        .route("/api/v1/sessions/:provider", post(move |path: axum::extract::Path<String>, body: axum::Json<serde_json::Value>| {
            let p = sp_api.clone();
            let r = rs_api.clone();
            async move { sessions::push_session_handler(path, body, p, r).await }
        }))
        .route("/proxy/polychat/v1/sessions/:provider", post(move |path: axum::extract::Path<String>, body: axum::Json<serde_json::Value>| {
            let p = sp_proxy.clone();
            let r = rs_proxy.clone();
            async move { sessions::push_session_handler(path, body, p, r).await }
        }))
        .route("/v1/sessions/:provider", delete(move |path: axum::extract::Path<String>| {
            let p = sd.clone();
            let r = rsd.clone();
            async move { sessions::delete_session_handler(path, p, r).await }
        }))
        .route("/api/v1/sessions/:provider", delete(move |path: axum::extract::Path<String>| {
            let p = sd_api.clone();
            let r = rsd_api.clone();
            async move { sessions::delete_session_handler(path, p, r).await }
        }))
        .route("/proxy/polychat/v1/sessions/:provider", delete(move |path: axum::extract::Path<String>| {
            let p = sd_proxy.clone();
            let r = rsd_proxy.clone();
            async move { sessions::delete_session_handler(path, p, r).await }
        }))
        .route("/api/generate", post(move |body: axum::Json<generate::GenerateRequest>| {
            let p = pg.clone();
            let c = cg.clone();
            let r = rg.clone();
            async move { generate::generate_handler(body, p, c, r).await }
        }))
        .route("/shutdown", post(shutdown::shutdown_handler))
        .with_state(ShutdownState {
            tx: Arc::new(Mutex::new(Some(shutdown_tx))),
        })
        .layer(axum::middleware::from_fn(auth_middleware))
        .layer(TimeoutLayer::new(Duration::from_secs(120)))
        .layer(CorsLayer::permissive())
}
