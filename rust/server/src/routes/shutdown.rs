//! POST /shutdown route — triggers graceful server shutdown.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot::Sender;

/// Shared state: the sender half of the shutdown signal channel.
/// Wrapped in Arc<Mutex<Option<>>> because oneshot::Sender is not Clone
/// and axum requires state to be Clone + Send + Sync.
#[derive(Clone)]
pub struct ShutdownState {
    pub tx: Arc<Mutex<Option<Sender<()>>>>,
}

pub async fn shutdown_handler(State(state): State<ShutdownState>) -> (StatusCode, Json<Value>) {
    if let Some(tx) = state.tx.lock().unwrap().take() {
        let _ = tx.send(());
        (
            StatusCode::OK,
            Json(json!({ "status": "shutting_down" })),
        )
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "shutdown already triggered" })),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[test]
    fn shutdown_state_clones_share_sender() {
        let (tx, _rx) = oneshot::channel::<()>();
        let state = ShutdownState {
            tx: Arc::new(Mutex::new(Some(tx))),
        };
        let state2 = state.clone();
        // Both clones point to the same Arc
        assert!(Arc::ptr_eq(&state.tx, &state2.tx));
    }

    #[tokio::test]
    async fn shutdown_handler_sends_signal() {
        let (tx, rx) = oneshot::channel::<()>();
        let state = ShutdownState {
            tx: Arc::new(Mutex::new(Some(tx))),
        };
        let result = shutdown_handler(State(state)).await;
        assert_eq!(result.0, StatusCode::OK);
        // The receiver should be notified
        assert!(rx.await.is_ok());
    }

    #[tokio::test]
    async fn shutdown_handler_returns_error_on_second_call() {
        let (tx, _rx) = oneshot::channel::<()>();
        let state = ShutdownState {
            tx: Arc::new(Mutex::new(Some(tx))),
        };
        // First call consumes the sender
        let _ = shutdown_handler(State(state.clone())).await;
        // Second call should return 503
        let result = shutdown_handler(State(state)).await;
        assert_eq!(result.0, StatusCode::SERVICE_UNAVAILABLE);
    }
}
