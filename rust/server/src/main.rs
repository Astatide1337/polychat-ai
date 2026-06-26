//! Polychat server.

mod auth;
mod config;
mod mcp;
mod model_aliases;
mod pow;
mod providers;
mod router;
mod routes;
mod session;
mod tools;

use providers::chatgpt::ChatGptProvider;
use providers::claude::ClaudeProvider;
use providers::deepseek::DeepSeekProvider;
use providers::gemini::GeminiProvider;
use providers::kimi::KimiProvider;
use providers::Provider;
use routes::model_registry::ModelRegistry;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    config::load_dot_env();

    if let Err(e) = config::get_secret_key() {
        eprintln!("ERROR: {}", e);
        eprintln!("Generate one with: openssl rand -hex 32");
        std::process::exit(1);
    }

    let config = match config::load_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("ERROR: Failed to load config: {}", e);
            std::process::exit(1);
        }
    };

    if let Err(e) = session::encryption_self_test() {
        eprintln!("ERROR: Encryption self-test failed: {}", e);
        std::process::exit(1);
    }
    tracing::info!("Encryption self-test passed");

    let mut provider_map: HashMap<String, Arc<dyn Provider>> = HashMap::new();
    for (id, name, _default_model) in config::PROVIDERS {
        if session::has_session(id) {
            match session::load_session(id) {
                Ok(_) => {
                    tracing::info!("✓ {} session file present and decryptable", name);
                }
                Err(e) => {
                    tracing::warn!("✗ {} session file present but decrypt failed: {}", name, e);
                    continue;
                }
            }
        } else {
            tracing::info!("○ {} not connected (no session file)", name);
            continue;
        }

        let provider: Arc<dyn Provider> = match *id {
            "deepseek" => Arc::new(DeepSeekProvider::new()),
            "claude" => Arc::new(ClaudeProvider::new()),
            "chatgpt" => Arc::new(ChatGptProvider::new()),
            "gemini" => Arc::new(GeminiProvider::new()),
            "kimi" => Arc::new(KimiProvider::new()),
            _ => continue,
        };
        provider_map.insert(id.to_string(), provider);
    }
    tracing::info!("{} provider(s) loaded", provider_map.len());

    let args: Vec<String> = std::env::args().collect();
    let mut port = config.server.port;
    let mut host = config.server.host.clone();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                if i + 1 < args.len() {
                    port = args[i + 1].parse().unwrap_or(port);
                    i += 1;
                }
            }
            "--host" => {
                if i + 1 < args.len() {
                    host = args[i + 1].clone();
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }

    let providers = Arc::new(provider_map);

    // Build model registry from all connected providers
    let registry = ModelRegistry::build(&providers).await;
    tracing::info!("Model registry built with {} models", registry.len());
    let registry = Arc::new(RwLock::new(registry));

    let config = Arc::new(config);

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let app = router::build_router(providers, config, registry, shutdown_tx);

    let addr = format!("{}:{}", host, port);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                eprintln!("ERROR: Port {}:{} is already in use.", host, port);
            } else {
                eprintln!("ERROR: Failed to bind {}:{}: {}", host, port, e);
            }
            std::process::exit(1);
        }
    };
    tracing::info!("Polychat server running at http://{}:{}", host, port);

    let shutdown_signal = async {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("Shutting down (SIGINT)...");
            }
            _ = shutdown_rx => {
                tracing::info!("Shutting down (POST /shutdown)...");
            }
        }
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal)
        .await
        .unwrap_or_else(|e| {
            eprintln!("Server error: {}", e);
            std::process::exit(1);
        });
}
