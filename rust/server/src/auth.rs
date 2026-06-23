//! Bearer token auth middleware — mirrors `src/server/middleware/auth.ts`

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::config::get_api_key;
use crate::session::safe_equal;

/// Axum middleware that enforces `Authorization: Bearer <POLYCHAT_API_KEY>`.
/// `GET /health` is intentionally public.
pub async fn auth_middleware(req: Request<Body>, next: Next) -> Response {
    let api_key = match get_api_key() {
        Some(k) => k,
        None => return next.run(req).await, // No API key configured → no auth
    };

    // /health and static WebUI assets are intentionally public. API routes remain protected.
    let path = req.uri().path();
    let public_webui_get = req.method() == "GET"
        && (path == "/"
            || path.starts_with("/assets/")
            || (!path.starts_with("/v1/")
                && !path.starts_with("/api/")
                && path != "/shutdown"
                && !path.contains('.')));
    if (req.method() == "GET" && path == "/health") || public_webui_get {
        return next.run(req).await;
    }

    let header = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let token = if header.starts_with("Bearer ") {
        &header[7..]
    } else {
        ""
    };

    if !safe_equal(token, &api_key) {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({
                "error": {
                    "message": "Unauthorized",
                    "type": "authentication_error",
                    "code": "invalid_api_key"
                }
            })),
        )
            .into_response();
    }

    next.run(req).await
}
