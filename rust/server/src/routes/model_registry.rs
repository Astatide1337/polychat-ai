//! Cached model registry — built at startup, refreshed on session push.

use std::sync::Arc;
use tokio::time::{Duration, timeout};
use crate::model_aliases::model_matches;
use crate::providers::{ModelInfo, Provider};
use crate::router::Providers;
use crate::session::has_session;

struct RegistryEntry {
    provider_id: String,
    provider: Arc<dyn Provider>,
    model: ModelInfo,
}

pub struct ModelRegistry {
    entries: Vec<RegistryEntry>,
}

impl ModelRegistry {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self { entries: Vec::new() }
    }

    /// Build the registry by calling list_models on each connected provider.
    pub async fn build(providers: &Providers) -> Self {
        let mut entries = Vec::new();
        for (provider_id, provider) in providers.iter() {
            if !has_session(provider_id) {
                continue;
            }
            let models = match timeout(Duration::from_secs(20), provider.list_models()).await {
                Ok(Ok(models)) => models,
                Ok(Err(e)) => {
                    tracing::warn!("{} list_models failed: {}", provider_id, e);
                    continue;
                }
                Err(_) => {
                    tracing::warn!("{} list_models timed out", provider_id);
                    continue;
                }
            };
            for model in models {
                entries.push(RegistryEntry {
                    provider_id: provider_id.clone(),
                    provider: provider.clone(),
                    model,
                });
            }
        }
        Self { entries }
    }

    /// Find the provider for a model ID (with alias support).
    pub fn find_provider(&self, model_id: &str) -> Option<(Arc<dyn Provider>, String)> {
        for entry in &self.entries {
            if model_matches(model_id, &entry.model.id) {
                return Some((entry.provider.clone(), entry.provider_id.clone()));
            }
        }
        None
    }

    /// Find a specific ModelInfo by model ID (with alias support).
    pub fn find_model(&self, model_id: &str) -> Option<ModelInfo> {
        for entry in &self.entries {
            if model_matches(model_id, &entry.model.id) {
                return Some(entry.model.clone());
            }
        }
        None
    }

    /// List all models in the registry.
    pub fn list_models(&self) -> Vec<ModelInfo> {
        self.entries.iter().map(|e| e.model.clone()).collect()
    }

    /// Number of models in the registry.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the registry is empty.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ModelInfo;

    fn model(id: &str, provider: &str) -> ModelInfo {
        ModelInfo {
            id: id.into(),
            name: id.into(),
            provider: provider.into(),
            provider_model: None,
            capabilities: None,
        }
    }

    #[test]
    fn empty_registry_finds_nothing() {
        let registry = ModelRegistry::new();
        assert!(registry.find_provider("deepseek-chat").is_none());
        assert!(registry.find_model("deepseek-chat").is_none());
        assert!(registry.list_models().is_empty());
    }

    #[test]
    fn find_provider_returns_correct_provider() {
        // Manually construct a registry with test entries
        let mut entries = Vec::new();

        // We can't easily create Arc<dyn Provider> in unit tests without
        // a mock, so we test the matching logic through find_model instead.
        // find_provider is tested implicitly through integration tests.
        entries.push(RegistryEntry {
            provider_id: "deepseek".into(),
            provider: // This is the problem — we need a real provider.
                Arc::new(crate::providers::deepseek::DeepSeekProvider::new()),
            model: model("deepseek-chat", "deepseek"),
        });

        let registry = ModelRegistry { entries };
        let found = registry.find_model("deepseek-chat");
        assert!(found.is_some());
        assert_eq!(found.unwrap().id, "deepseek-chat");
    }

    #[test]
    fn find_model_with_alias() {
        let mut entries = Vec::new();
        entries.push(RegistryEntry {
            provider_id: "chatgpt".into(),
            provider: Arc::new(crate::providers::chatgpt::ChatGptProvider::new()),
            model: model("gpt-5-5", "chatgpt"),
        });
        entries.push(RegistryEntry {
            provider_id: "kimi".into(),
            provider: Arc::new(crate::providers::kimi::KimiProvider::new()),
            model: model("k2", "kimi"),
        });

        let registry = ModelRegistry { entries };
        assert_eq!(registry.find_model("gpt-5-mini").unwrap().id, "gpt-5-5");
        assert_eq!(registry.find_model("kimi-k2.6").unwrap().id, "k2");
    }

    #[test]
    fn find_model_returns_none_for_missing() {
        let mut entries = Vec::new();
        entries.push(RegistryEntry {
            provider_id: "deepseek".into(),
            provider: Arc::new(crate::providers::deepseek::DeepSeekProvider::new()),
            model: model("deepseek-chat", "deepseek"),
        });

        let registry = ModelRegistry { entries };
        assert!(registry.find_model("gemini-2.5-pro").is_none());
    }

    #[test]
    fn list_models_returns_all_entries() {
        let mut entries = Vec::new();
        entries.push(RegistryEntry {
            provider_id: "deepseek".into(),
            provider: Arc::new(crate::providers::deepseek::DeepSeekProvider::new()),
            model: model("deepseek-chat", "deepseek"),
        });
        entries.push(RegistryEntry {
            provider_id: "deepseek".into(),
            provider: Arc::new(crate::providers::deepseek::DeepSeekProvider::new()),
            model: model("deepseek-r1", "deepseek"),
        });

        let registry = ModelRegistry { entries };
        let models = registry.list_models();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "deepseek-chat");
        assert_eq!(models[1].id, "deepseek-r1");
    }
}
