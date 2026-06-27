use std::collections::{HashMap, VecDeque};
use std::hash::Hasher;
use std::sync::{LazyLock, Mutex};

use crate::providers::ChatMessage;

const MAX_TRACKED_CONVERSATIONS: usize = 1000;

struct TrackedEntry {
    provider: String,
    conversation_id: String,
}

pub struct ConversationTracker {
    map: Mutex<HashMap<u64, TrackedEntry>>,
    order: Mutex<VecDeque<u64>>,
}

impl ConversationTracker {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            order: Mutex::new(VecDeque::new()),
        }
    }

    pub fn lookup(&self, messages: &[ChatMessage]) -> Option<(String, String)> {
        if messages.len() <= 1 {
            return None;
        }

        let guard = self.map.lock().unwrap();
        let mut history_len = messages.len() - 1;

        while history_len > 0 {
            let hash = tracker_message_hash(&messages[..history_len]);
            if let Some(entry) = guard.get(&hash) {
                return Some((entry.provider.clone(), entry.conversation_id.clone()));
            }

            let last_role = messages[history_len - 1].role.as_str();
            if last_role == "assistant" || last_role == "tool" {
                history_len -= 1;
                continue;
            }

            break;
        }

        None
    }

    pub fn store(&self, messages: &[ChatMessage], provider: &str, conversation_id: String) {
        if messages.is_empty() {
            return;
        }

        let hash = tracker_message_hash(messages);
        let mut map = self.map.lock().unwrap();
        let mut order = self.order.lock().unwrap();

        if !map.contains_key(&hash) {
            order.push_back(hash);
            while order.len() > MAX_TRACKED_CONVERSATIONS {
                if let Some(oldest) = order.pop_front() {
                    map.remove(&oldest);
                }
            }
        }

        map.insert(
            hash,
            TrackedEntry {
                provider: provider.to_string(),
                conversation_id,
            },
        );
    }
}

fn tracker_message_hash(messages: &[ChatMessage]) -> u64 {
    use std::collections::hash_map::DefaultHasher;

    let mut hasher = DefaultHasher::new();
    for message in messages {
        if message.role == "user" || message.role == "system" || message.role == "tool" {
            hasher.write(message.role.as_bytes());
            hasher.write_u8(0xff);
            if let Some(tool_call_id) = &message.tool_call_id {
                hasher.write(tool_call_id.as_bytes());
            }
            hasher.write_u8(0xfe);
            hasher.write(message.content.as_bytes());
            hasher.write_u8(0xfd);
        }
    }
    hasher.finish()
}

pub fn tracked_conversation_id(provider_id: &str, messages: &[ChatMessage]) -> Option<String> {
    TRACKER
        .lookup(messages)
        .and_then(|(tracked_provider, conversation_id)| {
            if tracked_provider == provider_id {
                Some(conversation_id)
            } else {
                None
            }
        })
}

pub static TRACKER: LazyLock<ConversationTracker> = LazyLock::new(ConversationTracker::new);

#[cfg(test)]
mod tests {
    use super::ConversationTracker;
    use crate::providers::ChatMessage;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
            tool_call_id: None,
        }
    }

    #[test]
    fn tracker_reuses_conversation_for_tool_result_follow_up() {
        let tracker = ConversationTracker::new();
        let cwd = "/workspace/polychat";
        let first_turn = vec![msg("user", "What is the current working directory?")];
        tracker.store(&first_turn, "chatgpt", "conv-1".into());

        let tool_follow_up = vec![
            msg("user", "What is the current working directory?"),
            msg("assistant", "Tool call call_1: bash({\"command\":\"pwd\"})"),
            ChatMessage {
                role: "tool".into(),
                content: cwd.into(),
                tool_call_id: Some("call_1".into()),
            },
        ];

        assert_eq!(
            tracker.lookup(&tool_follow_up),
            Some(("chatgpt".into(), "conv-1".into()))
        );
    }

    #[test]
    fn tracker_reuses_conversation_after_tool_result_on_next_user_turn() {
        let tracker = ConversationTracker::new();
        let cwd = "/workspace/polychat";
        let tool_turn = vec![
            msg("user", "What is the current working directory?"),
            msg("assistant", "Tool call call_1: bash({\"command\":\"pwd\"})"),
            ChatMessage {
                role: "tool".into(),
                content: cwd.into(),
                tool_call_id: Some("call_1".into()),
            },
        ];
        tracker.store(&tool_turn, "chatgpt", "conv-1".into());

        let next_user_turn = vec![
            msg("user", "What is the current working directory?"),
            msg("assistant", "Tool call call_1: bash({\"command\":\"pwd\"})"),
            ChatMessage {
                role: "tool".into(),
                content: cwd.into(),
                tool_call_id: Some("call_1".into()),
            },
            msg(
                "assistant",
                "The current working directory is /workspace/polychat.",
            ),
            msg("user", "What Rust files are in this project?"),
        ];

        assert_eq!(
            tracker.lookup(&next_user_turn),
            Some(("chatgpt".into(), "conv-1".into()))
        );
    }

    #[test]
    fn tracker_reuses_conversation_from_initial_tool_call_on_follow_up_user_turn() {
        let tracker = ConversationTracker::new();
        let cwd = "/workspace/polychat";
        let first_turn = vec![msg("user", "What is the current working directory?")];
        tracker.store(&first_turn, "chatgpt", "conv-1".into());

        let follow_up_user_turn = vec![
            msg("user", "What is the current working directory?"),
            msg("assistant", "Tool call call_1: bash({\"command\":\"pwd\"})"),
            ChatMessage {
                role: "tool".into(),
                content: cwd.into(),
                tool_call_id: Some("call_1".into()),
            },
            msg("user", "What kind of project is this?"),
        ];

        assert_eq!(
            tracker.lookup(&follow_up_user_turn),
            Some(("chatgpt".into(), "conv-1".into()))
        );
    }
}
