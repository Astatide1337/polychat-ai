use serde_json::Value;

const TOOL_START: &str = "<polychat_tool_call>";
const TOOL_END: &str = "</polychat_tool_call>";
const FINAL_START: &str = "<polychat_final>";
const FINAL_END: &str = "</polychat_final>";

#[derive(Debug)]
pub enum EmulatedToolResult {
    Final(String),
    ToolCall { name: String, arguments: String },
}

pub fn build_emulated_tool_prompt(tools: &[Value], tool_choice: Option<&Value>) -> String {
    let mut prompt = String::from(
        "You are operating in a strict tool protocol. Respond with exactly one block and no other text.\n\n\
If you can answer directly, respond with:\n\
<polychat_final>\n\
your final user-facing answer\n\
</polychat_final>\n\n\
If you need a tool, respond with:\n\
<polychat_tool_call>\n\
{\"name\":\"<tool_name>\",\"arguments\":{}}\n\
</polychat_tool_call>\n\n\
Rules:\n\
- Output exactly one block.\n\
- Never mix a block with commentary.\n\
- Arguments must be valid JSON.\n\
- Use exactly the JSON keys `name` and `arguments` inside `<polychat_tool_call>`.\n\
- Do not use XML tags like `<tool_name>`, `<tool_params>`, `<name>`, or `<arguments>`.\n\
- Arguments must contain only declared schema fields. Do not invent extra keys.\n\
- Call at most one tool per response.\n\
- Never mention or call a tool that is not listed below.\n\
- If the user already provided a tool result, use it to continue and either answer or call one next tool.\n\
- Never pretend a tool was run if it was not.\n\
- If the answer depends on the current filesystem, current working directory, environment, command output, external state, or any information not present in the transcript, you must call a tool instead of guessing.\n\n\
Available tools:",
    );

    for tool in tools {
        if let Some(function) = tool.get("function") {
            let name = function
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let description = function
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let params = function
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));

            prompt.push_str(&format!("\n- {}", name));
            if !description.is_empty() {
                prompt.push_str(&format!(": {}", description));
            }
            if let Ok(compact) = serde_json::to_string(&params) {
                prompt.push_str(&format!("\n  Parameters: {}", compact));
            }
        }
    }

    match tool_choice {
        Some(Value::String(choice)) if choice == "none" => {
            prompt.push_str("\n\nTool choice: none. You must not call a tool.");
        }
        Some(Value::String(choice)) if choice == "required" => {
            prompt.push_str("\n\nTool choice: required. You must call a tool.");
        }
        Some(Value::String(choice)) if choice != "auto" => {
            prompt.push_str(&format!("\n\nTool choice: {}", choice));
        }
        Some(Value::Object(obj)) => {
            if let Some(name) = obj
                .get("function")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
            {
                prompt.push_str(&format!(
                    "\n\nTool choice: you must call the tool `{}`.",
                    name
                ));
            }
        }
        _ => {}
    }

    prompt
}

pub fn parse_emulated_tool_response(text: &str) -> Result<EmulatedToolResult, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("response was empty".into());
    }

    let tool_blocks = find_blocks(trimmed, TOOL_START, TOOL_END);
    let final_blocks = find_blocks(trimmed, FINAL_START, FINAL_END);

    if !tool_blocks.is_empty() && !final_blocks.is_empty() {
        return Err("response included both final and tool-call blocks".into());
    }

    if !tool_blocks.is_empty() {
        let mut parsed = Vec::new();
        for (start, end) in tool_blocks {
            let body = trimmed[start + TOOL_START.len()..end].trim();
            if let Some(parsed_call) = parse_tool_block_body(body) {
                parsed.push(parsed_call);
            }
        }

        let first = parsed
            .first()
            .cloned()
            .ok_or_else(|| "response did not include a valid polychat tool block".to_string())?;
        if parsed.iter().any(|item| item != &first) {
            return Err("response contained multiple distinct tool-call blocks; return exactly one tool call".into());
        }
        return Ok(EmulatedToolResult::ToolCall {
            name: first.0,
            arguments: first.1,
        });
    }

    if !final_blocks.is_empty() {
        let bodies: Vec<String> = final_blocks
            .into_iter()
            .map(|(start, end)| trimmed[start + FINAL_START.len()..end].trim().to_string())
            .collect();
        let first = bodies
            .first()
            .cloned()
            .ok_or_else(|| "response did not include a polychat block".to_string())?;
        if bodies.iter().any(|body| body != &first) {
            return Err("response contained conflicting final-answer blocks".into());
        }
        return Ok(EmulatedToolResult::Final(first));
    }

    Err("response did not include a polychat block".into())
}

pub fn validate_emulated_tool_call(
    name: &str,
    arguments: &str,
    tools: &[Value],
    tool_choice: Option<&Value>,
) -> Result<(), String> {
    match tool_choice {
        Some(Value::String(choice)) if choice == "none" => {
            return Err("tool choice was `none`, but the model attempted a tool call".into());
        }
        Some(Value::Object(obj)) => {
            if let Some(required_name) = obj
                .get("function")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
            {
                if name != required_name {
                    return Err(format!(
                        "tool choice required `{}`, but the model called `{}`",
                        required_name, name
                    ));
                }
            }
        }
        _ => {}
    }

    let tool = tools
        .iter()
        .find(|tool| {
            tool.get("function")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
                == Some(name)
        })
        .ok_or_else(|| format!("unknown tool `{}`", name))?;

    let args_value: Value = serde_json::from_str(arguments)
        .map_err(|e| format!("tool arguments were not valid JSON: {}", e))?;

    let schema = tool
        .get("function")
        .and_then(|v| v.get("parameters"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    let mut errors = Vec::new();
    validate_json_schema(&args_value, &schema, "$", &mut errors);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub fn build_repair_prompt_with_context(
    error: &str,
    tools: &[Value],
    tool_choice: Option<&Value>,
) -> String {
    let allowed_tools = tools
        .iter()
        .filter_map(|tool| {
            tool.get("function")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
        })
        .collect::<Vec<_>>();

    let mut prompt = format!(
        "Your previous response was invalid: {}\nReturn exactly one corrected `<polychat_tool_call>` or `<polychat_final>` block and nothing else.\nUse the canonical tool-call shape only:\n<polychat_tool_call>\n{{\"name\":\"<tool_name>\",\"arguments\":{{}}}}\n</polychat_tool_call>",
        error
    );

    if !allowed_tools.is_empty() {
        prompt.push_str(&format!(
            "\nAllowed tool names: {}.",
            allowed_tools.join(", ")
        ));
    }

    match tool_choice {
        Some(Value::String(choice)) if choice == "none" => {
            prompt.push_str("\nTool choice is `none`; return `<polychat_final>` only.");
        }
        Some(Value::String(choice)) if choice == "required" => {
            prompt.push_str("\nTool choice is `required`; return one `<polychat_tool_call>` only.");
        }
        Some(Value::Object(obj)) => {
            if let Some(name) = obj
                .get("function")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
            {
                prompt.push_str(&format!("\nYou must call exactly this tool: `{}`.", name));
            }
        }
        _ => {}
    }

    prompt
}

fn find_blocks(text: &str, start_tag: &str, end_tag: &str) -> Vec<(usize, usize)> {
    let mut results = Vec::new();
    let mut search_from = 0;

    while let Some(rel_start) = text[search_from..].find(start_tag) {
        let start = search_from + rel_start;
        let body_start = start + start_tag.len();
        if let Some(rel_end) = text[body_start..].find(end_tag) {
            let end = body_start + rel_end;
            results.push((start, end));
            search_from = end + end_tag.len();
        } else {
            break;
        }
    }

    results
}

fn parse_tool_block_body(body: &str) -> Option<(String, String)> {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(name) = value
            .get("name")
            .or_else(|| value.get("tool_name"))
            .and_then(|v| v.as_str())
        {
            let args = value
                .get("arguments")
                .or_else(|| value.get("tool_params"))
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let arguments = serde_json::to_string(&args).ok()?;
            return Some((name.to_string(), arguments));
        }

        if value.is_object() {
            let arguments = serde_json::to_string(&value).ok()?;
            return Some((String::new(), arguments));
        }
    }

    let normalized = body
        .replace("<<name>", "<name>")
        .replace("<<arguments>", "<arguments>")
        .replace("<<parameters>", "<arguments>")
        .replace("<tool_name>", "<name>")
        .replace("</tool_name>", "</name>")
        .replace("<tool_params>", "<arguments>")
        .replace("</tool_params>", "</arguments>")
        .replace("<parameters>", "<arguments>")
        .replace("</parameters>", "</arguments>");
    let name = extract_tag_body(&normalized, "name")?;
    let args_body = extract_tag_body(&normalized, "arguments")?;
    let args_value: Value = serde_json::from_str(args_body.trim()).ok()?;
    let arguments = serde_json::to_string(&args_value).ok()?;
    Some((name.trim().to_string(), arguments))
}

fn extract_tag_body<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let start_tag = format!("<{}>", tag);
    let end_tag = format!("</{}>", tag);
    let start = text.find(&start_tag)? + start_tag.len();
    let end = text[start..].find(&end_tag)? + start;
    Some(&text[start..end])
}

fn validate_json_schema(value: &Value, schema: &Value, path: &str, errors: &mut Vec<String>) {
    let schema_type = schema.get("type").and_then(|v| v.as_str());
    if let Some(enum_values) = schema.get("enum") {
        if let Some(options) = enum_values.as_array() {
            if !options.iter().any(|option| option == value) {
                errors.push(format!("{} must be one of {}", path, enum_values));
            }
        }
    }

    match schema_type {
        Some("object") => validate_object(value, schema, path, errors),
        Some("array") => validate_array(value, schema, path, errors),
        Some("string") => {
            if !value.is_string() {
                errors.push(format!("{} must be a string", path));
            }
        }
        Some("integer") => {
            if value.as_i64().is_none() && value.as_u64().is_none() {
                errors.push(format!("{} must be an integer", path));
            }
        }
        Some("number") => {
            if value.as_f64().is_none() && value.as_i64().is_none() && value.as_u64().is_none() {
                errors.push(format!("{} must be a number", path));
            }
        }
        Some("boolean") => {
            if !value.is_boolean() {
                errors.push(format!("{} must be a boolean", path));
            }
        }
        Some("null") => {
            if !value.is_null() {
                errors.push(format!("{} must be null", path));
            }
        }
        _ => {}
    }
}

fn validate_object(value: &Value, schema: &Value, path: &str, errors: &mut Vec<String>) {
    let Some(obj) = value.as_object() else {
        errors.push(format!("{} must be an object", path));
        return;
    };

    let properties = schema
        .get("properties")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    if let Some(required) = schema.get("required").and_then(|v| v.as_array()) {
        for key in required.iter().filter_map(|v| v.as_str()) {
            if !obj.contains_key(key) {
                errors.push(format!("{} is missing required property `{}`", path, key));
            }
        }
    }

    let allow_additional = schema
        .get("additionalProperties")
        .and_then(|v| v.as_bool())
        .unwrap_or(properties.is_empty());

    for (key, value) in obj {
        if let Some(child_schema) = properties.get(key) {
            validate_json_schema(value, child_schema, &format!("{}.{}", path, key), errors);
        } else if !allow_additional {
            errors.push(format!("{} has unexpected property `{}`", path, key));
        }
    }
}

fn validate_array(value: &Value, schema: &Value, path: &str, errors: &mut Vec<String>) {
    let Some(items) = value.as_array() else {
        errors.push(format!("{} must be an array", path));
        return;
    };

    if let Some(item_schema) = schema.get("items") {
        for (idx, item) in items.iter().enumerate() {
            validate_json_schema(item, item_schema, &format!("{}[{}]", path, idx), errors);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_tool_block() {
        let parsed = parse_emulated_tool_response(
            "<polychat_tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}</polychat_tool_call>",
        )
        .unwrap();
        match parsed {
            EmulatedToolResult::ToolCall { name, arguments } => {
                assert_eq!(name, "bash");
                assert_eq!(arguments, r#"{"command":"ls"}"#);
            }
            EmulatedToolResult::Final(_) => panic!("expected tool call"),
        }
    }

    #[test]
    fn rejects_mixed_text() {
        let parsed = parse_emulated_tool_response(
            "Sure\n<polychat_tool_call>{\"name\":\"bash\",\"arguments\":{}}</polychat_tool_call>",
        )
        .unwrap();
        match parsed {
            EmulatedToolResult::ToolCall { name, .. } => assert_eq!(name, "bash"),
            EmulatedToolResult::Final(_) => panic!("expected tool call"),
        }
    }

    #[test]
    fn accepts_duplicate_tool_blocks() {
        let parsed = parse_emulated_tool_response(
            concat!(
                "<polychat_tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"pwd\"}}</polychat_tool_call>",
                "<polychat_tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"pwd\"}}</polychat_tool_call>"
            ),
        )
        .unwrap();
        match parsed {
            EmulatedToolResult::ToolCall { arguments, .. } => {
                assert_eq!(arguments, r#"{"command":"pwd"}"#);
            }
            EmulatedToolResult::Final(_) => panic!("expected tool call"),
        }
    }

    #[test]
    fn accepts_args_only_json_block() {
        let parsed = parse_emulated_tool_response(
            "<polychat_tool_call>{\"command\":\"pwd\"}</polychat_tool_call>",
        )
        .unwrap();
        match parsed {
            EmulatedToolResult::ToolCall { name, arguments } => {
                assert!(name.is_empty());
                assert_eq!(arguments, r#"{"command":"pwd"}"#);
            }
            EmulatedToolResult::Final(_) => panic!("expected tool call"),
        }
    }

    #[test]
    fn accepts_xml_like_tool_block() {
        let parsed = parse_emulated_tool_response(
            "<polychat_tool_call><<name>bash</name>\n<<arguments>\n{\"command\":\"pwd\"}\n</arguments>\n</polychat_tool_call>",
        )
        .unwrap();
        match parsed {
            EmulatedToolResult::ToolCall { name, arguments } => {
                assert_eq!(name, "bash");
                assert_eq!(arguments, r#"{"command":"pwd"}"#);
            }
            EmulatedToolResult::Final(_) => panic!("expected tool call"),
        }
    }

    #[test]
    fn accepts_parameters_alias_block() {
        let parsed = parse_emulated_tool_response(
            "<polychat_tool_call><<name>bash</name><<parameters>{\"command\":\"pwd\"}</parameters></polychat_tool_call>",
        )
        .unwrap();
        match parsed {
            EmulatedToolResult::ToolCall { name, arguments } => {
                assert_eq!(name, "bash");
                assert_eq!(arguments, r#"{"command":"pwd"}"#);
            }
            EmulatedToolResult::Final(_) => panic!("expected tool call"),
        }
    }

    #[test]
    fn accepts_tool_name_tool_params_block() {
        let parsed = parse_emulated_tool_response(
            "<polychat_tool_call><tool_name>bash</tool_name><tool_params>{\"command\":\"pwd\"}</tool_params></polychat_tool_call>",
        )
        .unwrap();
        match parsed {
            EmulatedToolResult::ToolCall { name, arguments } => {
                assert_eq!(name, "bash");
                assert_eq!(arguments, r#"{"command":"pwd"}"#);
            }
            EmulatedToolResult::Final(_) => panic!("expected tool call"),
        }
    }

    #[test]
    fn rejects_multiple_distinct_tool_blocks() {
        let err = parse_emulated_tool_response(
            concat!(
                "<polychat_tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"pwd\"}}</polychat_tool_call>",
                "<polychat_tool_call>{\"name\":\"write_file\",\"arguments\":{\"file_path\":\"hello.py\"}}</polychat_tool_call>"
            ),
        )
        .unwrap_err();
        assert!(err.contains("multiple distinct tool-call blocks"));
    }

    #[test]
    fn validates_required_fields() {
        let tools = vec![json!({
            "type": "function",
            "function": {
                "name": "bash",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string"}
                    },
                    "required": ["command"],
                    "additionalProperties": false
                }
            }
        })];

        let err = validate_emulated_tool_call("bash", "{}", &tools, None).unwrap_err();
        assert!(err.contains("missing required property `command`"));
    }

    #[test]
    fn rejects_unexpected_fields_by_default() {
        let tools = vec![json!({
            "type": "function",
            "function": {
                "name": "bash",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string"}
                    },
                    "required": ["command"]
                }
            }
        })];

        let err = validate_emulated_tool_call(
            "bash",
            r#"{"command":"pwd","description":"Get cwd"}"#,
            &tools,
            None,
        )
        .unwrap_err();
        assert!(err.contains("unexpected property `description`"));
    }
}
