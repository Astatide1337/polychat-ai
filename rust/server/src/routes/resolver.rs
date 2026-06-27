use crate::model_aliases::model_matches;
use crate::providers::ModelInfo;

#[allow(dead_code)]
fn find_matching_model(model_id: &str, models: &[ModelInfo]) -> Option<ModelInfo> {
    models
        .iter()
        .find(|m| model_matches(model_id, &m.id))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::find_matching_model;
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
    fn finds_exact_model_match() {
        let models = vec![model("claude-sonnet-4-6", "claude")];
        let found = find_matching_model("claude-sonnet-4-6", &models).unwrap();
        assert_eq!(found.id, "claude-sonnet-4-6");
        assert_eq!(found.provider, "claude");
    }

    #[test]
    fn finds_alias_model_match() {
        let models = vec![model("gpt-5-5", "chatgpt"), model("k2", "kimi")];
        assert_eq!(
            find_matching_model("gpt-5-mini", &models).unwrap().id,
            "gpt-5-5"
        );
        assert_eq!(find_matching_model("kimi-k2.6", &models).unwrap().id, "k2");
    }

    #[test]
    fn returns_none_for_missing_model() {
        let models = vec![model("deepseek-chat", "deepseek")];
        assert!(find_matching_model("gemini-2.5-pro", &models).is_none());
    }
}
