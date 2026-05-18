use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

pub struct RouteError {
    pub status: StatusCode,
    pub message: String,
    pub err_type: &'static str,
    pub code: &'static str,
}

impl RouteError {
    pub fn new(
        status: StatusCode,
        message: impl Into<String>,
        err_type: &'static str,
        code: &'static str,
    ) -> Self {
        Self {
            status,
            message: message.into(),
            err_type,
            code,
        }
    }

    pub fn into_json(self) -> (StatusCode, Json<Value>) {
        (
            self.status,
            Json(json!({
                "error": { "message": self.message, "type": self.err_type, "code": self.code }
            })),
        )
    }

    pub fn into_response(self) -> Response {
        self.into_json().into_response()
    }
}
