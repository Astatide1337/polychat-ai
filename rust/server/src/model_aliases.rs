pub fn canonical_model_id(model: &str) -> Option<&'static str> {
    match model {
        "gpt-5-mini" | "gpt-4.1-mini" => Some("gpt-5-5"),
        "deepseek-v4-flash" => Some("deepseek-chat"),
        "gemini-3.1-flash-lite" | "gemini-3-flash" => Some("gemini-2.5-flash"),
        "gemini-3.1-pro" | "gemini-3-pro" => Some("gemini-2.5-pro"),
        "kimi-k2.6" | "kimi-k2" => Some("k2"),
        _ => None,
    }
}

pub fn model_matches(requested: &str, available: &str) -> bool {
    requested == available || canonical_model_id(requested) == Some(available)
}

#[cfg(test)]
mod tests {
    use super::{canonical_model_id, model_matches};

    #[test]
    fn resolves_known_legacy_aliases() {
        assert_eq!(canonical_model_id("gpt-5-mini"), Some("gpt-5-5"));
        assert_eq!(canonical_model_id("gpt-4.1-mini"), Some("gpt-5-5"));
        assert_eq!(
            canonical_model_id("deepseek-v4-flash"),
            Some("deepseek-chat")
        );
        assert_eq!(
            canonical_model_id("gemini-3.1-flash-lite"),
            Some("gemini-2.5-flash")
        );
        assert_eq!(canonical_model_id("kimi-k2.6"), Some("k2"));
    }

    #[test]
    fn model_matching_checks_exact_then_alias() {
        assert!(model_matches("k2", "k2"));
        assert!(model_matches("kimi-k2.6", "k2"));
        assert!(model_matches("gemini-3-pro", "gemini-2.5-pro"));
        assert!(!model_matches("kimi-k2.5", "k2"));
    }
}
