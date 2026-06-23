import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Bug,
  CheckCircle2,
  ChevronRight,
  Copy,
  Database,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  RefreshCw,
  Send,
  Server,
  Settings,
  ShieldAlert,
  Square,
  TerminalSquare,
  Trash2,
  WifiOff,
} from "lucide-react";
import { PolychatApiError, PolychatClient } from "./lib/polychat-client";
import { loadSessions, loadSettings, saveSessions, saveSettings } from "./lib/storage";
import type {
  ChatMessage,
  ChatSession,
  ConversationListResponse,
  HealthResponse,
  McpServersResponse,
  McpToolsResponse,
  ModelInfo,
  ProviderConversation,
  ProviderId,
  ToolCall,
  WebSettings,
} from "./lib/types";

const providerOrder = ["all", "chatgpt", "claude", "deepseek", "gemini", "kimi"];
const providerNames: Record<string, string> = {
  all: "All",
  chatgpt: "ChatGPT",
  claude: "Claude",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  kimi: "Kimi",
};

function nowIso() {
  return new Date().toISOString();
}

function newSession(model: string | null = null, provider: string | null = null): ChatSession {
  const now = nowIso();
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    provider,
    model,
    providerConversationId: null,
    temporary: false,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function message(role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: nowIso(),
    ...extra,
  };
}

function titleFromText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 45)}...` : compact || "New chat";
}

export function App() {
  const [settings, setSettings] = useState<WebSettings>(() => loadSettings());
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const stored = loadSessions();
    return stored.length ? stored : [newSession()];
  });
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0]?.id ?? "");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [conversations, setConversations] = useState<ConversationListResponse | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServersResponse | null>(null);
  const [mcpTools, setMcpTools] = useState<McpToolsResponse | null>(null);
  const [providerFilter, setProviderFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [debugJson, setDebugJson] = useState<unknown>(null);
  const abortRef = useRef<AbortController | null>(null);

  const client = useMemo(() => new PolychatClient(settings.baseUrl, settings.apiKey), [settings.baseUrl, settings.apiKey]);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const modelById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const selectedModel = activeSession?.model ? modelById.get(activeSession.model) : null;
  const selectedProvider = activeSession?.provider ?? selectedModel?.owned_by ?? null;
  const connectedProviders = Object.values(health?.providers ?? {}).filter((provider) => provider.connected).length;
  const serverUrl = settings.baseUrl || window.location.origin;

  const groupedModels = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>();
    for (const model of models) {
      if (providerFilter !== "all" && model.owned_by !== providerFilter) continue;
      const group = groups.get(model.owned_by) ?? [];
      group.push(model);
      groups.set(model.owned_by, group);
    }
    return groups;
  }, [models, providerFilter]);

  const updateSettings = useCallback((next: Partial<WebSettings>) => {
    setSettings((current) => {
      const updated = { ...current, ...next };
      saveSettings(updated);
      return updated;
    });
  }, []);

  const updateSession = useCallback((id: string, updater: (session: ChatSession) => ChatSession) => {
    setSessions((current) => {
      const updated = current.map((session) => session.id === id ? updater(session) : session);
      saveSessions(updated);
      return updated;
    });
  }, []);

  const replaceSessions = useCallback((updater: (sessions: ChatSession[]) => ChatSession[]) => {
    setSessions((current) => {
      const updated = updater(current);
      saveSessions(updated);
      return updated;
    });
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setAuthRequired(false);
    try {
      const [nextHealth, nextModels] = await Promise.all([
        client.getHealth(),
        client.listModels(),
      ]);
      setHealth(nextHealth);
      setModels(nextModels.data);
      setLastRefresh(new Date().toLocaleTimeString());
      if (!activeSession?.model && nextModels.data[0]) {
        updateSession(activeSession.id, (session) => ({
          ...session,
          model: nextModels.data[0].id,
          provider: nextModels.data[0].owned_by,
          updatedAt: nowIso(),
        }));
      }
    } catch (err) {
      if (err instanceof PolychatApiError && err.status === 401) setAuthRequired(true);
      setError(formatError(err));
    } finally {
      setIsLoading(false);
    }
  }, [activeSession?.id, activeSession?.model, client, updateSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedProvider) {
      setConversations(null);
      return;
    }
    client.listConversations(selectedProvider)
      .then(setConversations)
      .catch((err) => setConversations({
        provider: selectedProvider,
        supported: false,
        reason: formatError(err),
      }));
  }, [client, selectedProvider]);

  useEffect(() => {
    if (settings.inspectorTab !== "mcp") return;
    Promise.all([client.listMcpServers(), client.listMcpTools()])
      .then(([servers, tools]) => {
        setMcpServers(servers);
        setMcpTools(tools);
      })
      .catch((err) => setError(formatError(err)));
  }, [client, settings.inspectorTab]);

  const chooseModel = (modelId: string) => {
    const model = modelById.get(modelId);
    if (!activeSession || !model) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      model: model.id,
      provider: model.owned_by,
      providerConversationId: session.temporary ? null : session.providerConversationId,
      updatedAt: nowIso(),
    }));
  };

  const createNewChat = () => {
    const baseModel = models.find((model) => providerFilter === "all" || model.owned_by === providerFilter) ?? models[0];
    const session = newSession(baseModel?.id ?? null, baseModel?.owned_by ?? (providerFilter === "all" ? null : providerFilter));
    replaceSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
    setDebugJson(null);
  };

  const selectConversation = (conversation: ProviderConversation) => {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      title: conversation.title || session.title,
      provider: conversation.provider,
      model: conversation.modelId ?? session.model,
      providerConversationId: conversation.id,
      temporary: false,
      messages: [],
      updatedAt: nowIso(),
    }));
    setDebugJson(conversation.providerDebug ?? null);
  };

  const setTemporary = (temporary: boolean) => {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      temporary,
      providerConversationId: temporary ? null : session.providerConversationId,
      updatedAt: nowIso(),
    }));
  };

  const sendMessage = async (content: string) => {
    if (!activeSession || !activeSession.model || isStreaming) return;
    const userMessage = message("user", content);
    const assistantMessage = message("assistant", "", {
      status: "streaming",
      provider: selectedProvider,
      model: activeSession.model,
    });
    const nextTitle = activeSession.messages.length === 0 ? titleFromText(content) : activeSession.title;
    const requestMessages = [...activeSession.messages, userMessage]
      .filter((item) => item.role === "system" || item.role === "user" || item.role === "assistant" || item.role === "tool")
      .map((item) => ({ role: item.role, content: item.content }));

    updateSession(activeSession.id, (session) => ({
      ...session,
      title: nextTitle,
      messages: [...session.messages, userMessage, assistantMessage],
      updatedAt: nowIso(),
    }));

    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);
    setError(null);
    setDebugJson(null);
    const started = performance.now();

    try {
      await client.streamChatCompletion({
        model: activeSession.model,
        messages: requestMessages,
        provider_conversation_id: activeSession.temporary ? null : activeSession.providerConversationId,
        temporary: activeSession.temporary,
        include_provider_debug: true,
      }, {
        signal: controller.signal,
        onContent: (text) => appendAssistant(assistantMessage.id, { content: text }),
        onThinking: (text) => appendAssistant(assistantMessage.id, { thinking: text }),
        onToolCalls: (toolCalls) => appendToolCalls(assistantMessage.id, toolCalls),
        onDebug: setDebugJson,
      });
      const elapsed = Math.round(performance.now() - started);
      updateMessage(assistantMessage.id, { status: "done", error: `${elapsed} ms` });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        updateMessage(assistantMessage.id, { status: "cancelled", error: "Cancelled" });
      } else {
        const nextError = formatError(err);
        setError(nextError);
        updateMessage(assistantMessage.id, { status: "error", error: nextError });
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  };

  const appendAssistant = (messageId: string, patch: { content?: string; thinking?: string }) => {
    updateMessage(messageId, undefined, (current) => ({
      ...current,
      content: current.content + (patch.content ?? ""),
      thinking: `${current.thinking ?? ""}${patch.thinking ?? ""}`,
    }));
  };

  const appendToolCalls = (messageId: string, toolCalls: ToolCall[]) => {
    updateMessage(messageId, undefined, (current) => ({
      ...current,
      toolCalls: [...(current.toolCalls ?? []), ...toolCalls],
    }));
  };

  const updateMessage = (messageId: string, patch?: Partial<ChatMessage>, custom?: (message: ChatMessage) => ChatMessage) => {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      messages: session.messages.map((item) => {
        if (item.id !== messageId) return item;
        return custom ? custom(item) : { ...item, ...patch };
      }),
      updatedAt: nowIso(),
    }));
  };

  const regenerate = () => {
    if (!activeSession || isStreaming) return;
    const lastUser = [...activeSession.messages].reverse().find((item) => item.role === "user");
    if (!lastUser) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      messages: session.messages.filter((item) => item.id !== lastUser.id && item.role !== "assistant"),
      updatedAt: nowIso(),
    }));
    void sendMessage(lastUser.content);
  };

  const requestPreview = {
    model: activeSession?.model,
    provider_conversation_id: activeSession?.temporary ? null : activeSession?.providerConversationId,
    temporary: activeSession?.temporary,
    include_provider_debug: true,
    stream: true,
  };

  return (
    <div className="app-shell">
      <Sidebar
        health={health}
        sessions={sessions}
        activeSessionId={activeSession?.id}
        providerFilter={providerFilter}
        serverUrl={serverUrl}
        connectedProviders={connectedProviders}
        onFilter={setProviderFilter}
        onNewChat={createNewChat}
        onSelectSession={setActiveSessionId}
        onDeleteSession={(id) => replaceSessions((current) => {
          const remaining = current.filter((session) => session.id !== id);
          if (activeSessionId === id && remaining[0]) setActiveSessionId(remaining[0].id);
          return remaining.length ? remaining : [newSession()];
        })}
      />

      <main className="main-pane">
        <TopBar
          groupedModels={groupedModels}
          selectedModel={activeSession?.model ?? ""}
          selectedProvider={selectedProvider}
          temporary={activeSession?.temporary ?? false}
          inspectorOpen={settings.inspectorOpen}
          authRequired={authRequired}
          onModelChange={chooseModel}
          onTemporaryChange={setTemporary}
          onRefresh={refresh}
          onToggleInspector={() => updateSettings({ inspectorOpen: !settings.inspectorOpen })}
        />

        {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}
        {authRequired ? (
          <AuthBanner
            apiKey={settings.apiKey}
            onApiKey={(apiKey) => updateSettings({ apiKey })}
          />
        ) : null}

        <ChatView
          session={activeSession}
          noProviders={!!health && connectedProviders === 0}
          onCopy={(text) => void navigator.clipboard?.writeText(text)}
          onRegenerate={regenerate}
        />

        <Composer
          disabled={!activeSession?.model || isStreaming || connectedProviders === 0}
          isStreaming={isStreaming}
          temporary={activeSession?.temporary ?? false}
          model={activeSession?.model ?? null}
          onSend={sendMessage}
          onCancel={() => abortRef.current?.abort()}
        />
      </main>

      {settings.inspectorOpen ? (
        <InspectorPanel
          settings={settings}
          serverUrl={serverUrl}
          health={health}
          lastRefresh={lastRefresh}
          selectedProvider={selectedProvider}
          selectedModel={activeSession?.model ?? null}
          providerConversationId={activeSession?.providerConversationId ?? null}
          temporary={activeSession?.temporary ?? false}
          requestPreview={requestPreview}
          debugJson={debugJson}
          conversations={conversations}
          mcpServers={mcpServers}
          mcpTools={mcpTools}
          isLoading={isLoading}
          onTab={(inspectorTab) => updateSettings({ inspectorTab })}
          onConversation={selectConversation}
        />
      ) : null}
    </div>
  );
}

function Sidebar(props: {
  health: HealthResponse | null;
  sessions: ChatSession[];
  activeSessionId?: string;
  providerFilter: string;
  serverUrl: string;
  connectedProviders: number;
  onFilter: (provider: string) => void;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark"><Bot size={18} /></div>
        <div>
          <strong>Polychat</strong>
          <span>Local WebUI</span>
        </div>
      </div>
      <button className="primary-button" onClick={props.onNewChat}>
        <MessageSquarePlus size={16} /> New chat
      </button>
      <div className="provider-tabs">
        {providerOrder.map((provider) => {
          const status = props.health?.providers?.[provider];
          return (
            <button
              key={provider}
              className={props.providerFilter === provider ? "active" : ""}
              onClick={() => props.onFilter(provider)}
            >
              {provider !== "all" ? <span className={status?.connected ? "dot good" : "dot"} /> : null}
              {providerNames[provider]}
            </button>
          );
        })}
      </div>
      <div className="sidebar-section-label">Local sessions</div>
      <div className="session-list">
        {props.sessions.map((session) => (
          <button
            key={session.id}
            className={`session-item ${session.id === props.activeSessionId ? "active" : ""}`}
            onClick={() => props.onSelectSession(session.id)}
          >
            <span>
              <strong>{session.title}</strong>
              <small>{session.model ?? "No model selected"}</small>
            </span>
            <Trash2
              size={14}
              onClick={(event) => {
                event.stopPropagation();
                props.onDeleteSession(session.id);
              }}
            />
          </button>
        ))}
      </div>
      <div className="server-footer">
        <Server size={16} />
        <span>
          <strong>{props.connectedProviders} connected</strong>
          <small>{props.serverUrl}</small>
        </span>
      </div>
    </aside>
  );
}

function TopBar(props: {
  groupedModels: Map<string, ModelInfo[]>;
  selectedModel: string;
  selectedProvider: string | null;
  temporary: boolean;
  inspectorOpen: boolean;
  authRequired: boolean;
  onModelChange: (model: string) => void;
  onTemporaryChange: (temporary: boolean) => void;
  onRefresh: () => void;
  onToggleInspector: () => void;
}) {
  return (
    <header className="top-bar">
      <div className="model-control">
        <select value={props.selectedModel} onChange={(event) => props.onModelChange(event.target.value)}>
          <option value="">Select model</option>
          {[...props.groupedModels.entries()].map(([provider, models]) => (
            <optgroup key={provider} label={providerNames[provider] ?? provider}>
              {models.map((model) => (
                <option key={model.id} value={model.id}>{model.id}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className="provider-pill">{props.selectedProvider ? providerNames[props.selectedProvider] ?? props.selectedProvider : "No provider"}</span>
      </div>
      <div className="top-actions">
        {props.authRequired ? <span className="auth-pill"><ShieldAlert size={14} /> API key needed</span> : null}
        <label className="switch">
          <input type="checkbox" checked={props.temporary} onChange={(event) => props.onTemporaryChange(event.target.checked)} />
          <span>Temporary</span>
        </label>
        <button className="icon-button" title="Refresh status" onClick={props.onRefresh}><RefreshCw size={16} /></button>
        <button className="icon-button" title="Toggle inspector" onClick={props.onToggleInspector}>
          {props.inspectorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
      </div>
    </header>
  );
}

function ChatView(props: {
  session?: ChatSession;
  noProviders: boolean;
  onCopy: (text: string) => void;
  onRegenerate: () => void;
}) {
  if (props.noProviders) {
    return (
      <section className="empty-state">
        <WifiOff size={32} />
        <h1>No providers connected</h1>
        <p>Run <code>polychat login chatgpt</code>, <code>polychat login claude</code>, or another provider login command, then refresh this page.</p>
      </section>
    );
  }

  if (!props.session?.messages.length) {
    return (
      <section className="empty-state">
        <Bot size={32} />
        <h1>Start a Polychat conversation</h1>
        <p>Select a model, choose temporary mode if needed, then send a normal chat prompt.</p>
      </section>
    );
  }

  return (
    <section className="chat-scroll">
      {props.session.messages.map((item) => (
        <MessageBubble key={item.id} message={item} onCopy={props.onCopy} onRegenerate={props.onRegenerate} />
      ))}
    </section>
  );
}

function MessageBubble(props: {
  message: ChatMessage;
  onCopy: (text: string) => void;
  onRegenerate: () => void;
}) {
  return (
    <article className={`message ${props.message.role}`}>
      <div className="message-avatar">{props.message.role === "user" ? "U" : <Bot size={16} />}</div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{props.message.role === "user" ? "You" : "Assistant"}</strong>
          <span>{new Date(props.message.createdAt).toLocaleTimeString()}</span>
          {props.message.status ? <span className={`status ${props.message.status}`}>{props.message.status}</span> : null}
        </div>
        {props.message.thinking ? (
          <details className="thinking">
            <summary>Thinking</summary>
            <pre>{props.message.thinking}</pre>
          </details>
        ) : null}
        <div className="message-content">{props.message.content || (props.message.status === "streaming" ? "Streaming..." : "")}</div>
        {props.message.toolCalls?.map((toolCall) => <ToolCallCard key={toolCall.id} toolCall={toolCall} />)}
        {props.message.error ? <div className="message-footer">{props.message.error}</div> : null}
        <div className="message-actions">
          <button title="Copy message" onClick={() => props.onCopy(props.message.content)}><Copy size={14} /></button>
          {props.message.role === "assistant" ? <button title="Regenerate" onClick={props.onRegenerate}><RefreshCw size={14} /></button> : null}
        </div>
      </div>
    </article>
  );
}

function ToolCallCard({ toolCall }: { toolCall: ToolCall }) {
  return (
    <div className="tool-card">
      <TerminalSquare size={15} />
      <span>
        <strong>{toolCall.function?.name ?? toolCall.type}</strong>
        <code>{toolCall.function?.arguments ?? "{}"}</code>
      </span>
    </div>
  );
}

function Composer(props: {
  disabled: boolean;
  isStreaming: boolean;
  temporary: boolean;
  model: string | null;
  onSend: (content: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const content = value.trim();
    if (!content || props.disabled) return;
    setValue("");
    void props.onSend(content);
  };

  return (
    <footer className="composer-wrap">
      <div className="composer-meta">
        <span>{props.model ?? "Select a model"}</span>
        {props.temporary ? <span>Temporary mode is provider dependent and does not bind provider conversations.</span> : null}
      </div>
      <div className="composer">
        <textarea
          value={value}
          disabled={props.disabled && !props.isStreaming}
          placeholder={props.disabled ? "Connect a provider and select a model to chat" : "Message Polychat"}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {props.isStreaming ? (
          <button className="send-button stop" onClick={props.onCancel} title="Cancel stream"><Square size={16} /></button>
        ) : (
          <button className="send-button" disabled={!value.trim() || props.disabled} onClick={submit} title="Send"><Send size={16} /></button>
        )}
      </div>
    </footer>
  );
}

function InspectorPanel(props: {
  settings: WebSettings;
  serverUrl: string;
  health: HealthResponse | null;
  lastRefresh: string | null;
  selectedProvider: string | null;
  selectedModel: string | null;
  providerConversationId: string | null;
  temporary: boolean;
  requestPreview: unknown;
  debugJson: unknown;
  conversations: ConversationListResponse | null;
  mcpServers: McpServersResponse | null;
  mcpTools: McpToolsResponse | null;
  isLoading: boolean;
  onTab: (tab: WebSettings["inspectorTab"]) => void;
  onConversation: (conversation: ProviderConversation) => void;
}) {
  return (
    <aside className="inspector">
      <div className="inspector-tabs">
        <button className={props.settings.inspectorTab === "status" ? "active" : ""} onClick={() => props.onTab("status")}><Activity size={14} /> Status</button>
        <button className={props.settings.inspectorTab === "debug" ? "active" : ""} onClick={() => props.onTab("debug")}><Bug size={14} /> Debug</button>
        <button className={props.settings.inspectorTab === "mcp" ? "active" : ""} onClick={() => props.onTab("mcp")}><Database size={14} /> MCP</button>
      </div>

      {props.settings.inspectorTab === "status" ? (
        <div className="inspector-content">
          <InfoRow label="Server" value={props.serverUrl} />
          <InfoRow label="Health" value={props.health?.status ?? (props.isLoading ? "loading" : "offline")} />
          <InfoRow label="Last refresh" value={props.lastRefresh ?? "not yet"} />
          <div className="panel-title">Providers</div>
          {Object.entries(props.health?.providers ?? {}).map(([id, provider]) => (
            <div className="provider-row" key={id}>
              {provider.connected ? <CheckCircle2 size={15} className="ok" /> : <Pause size={15} />}
              <span>
                <strong>{providerNames[id] ?? id}</strong>
                <small>{provider.defaultModel}</small>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {props.settings.inspectorTab === "debug" ? (
        <div className="inspector-content">
          <InfoRow label="Model" value={props.selectedModel ?? "none"} />
          <InfoRow label="Provider" value={props.selectedProvider ?? "none"} />
          <InfoRow label="Conversation" value={props.providerConversationId ?? "unbound"} />
          <InfoRow label="Temporary" value={props.temporary ? "enabled" : "disabled"} />
          <div className="panel-title">Provider conversations</div>
          <ConversationList conversations={props.conversations} onConversation={props.onConversation} />
          <div className="panel-title">Request preview</div>
          <JsonBlock value={props.requestPreview} />
          <div className="panel-title">Provider debug</div>
          <JsonBlock value={props.debugJson ?? { status: "No provider debug returned yet" }} />
        </div>
      ) : null}

      {props.settings.inspectorTab === "mcp" ? (
        <div className="inspector-content">
          <div className="panel-title">Servers</div>
          {props.mcpServers?.data.length ? props.mcpServers.data.map((server, index) => (
            <div className="mcp-row" key={String(server.id ?? server.name ?? index)}>
              <Settings size={14} />
              <span>{String(server.id ?? server.name ?? "MCP server")}</span>
            </div>
          )) : <p className="muted">No MCP servers configured.</p>}
          <div className="panel-title">Tools</div>
          {props.mcpTools?.data.length ? props.mcpTools.data.map((tool) => (
            <div className="mcp-row" key={tool.function?.name ?? tool.type}>
              <ChevronRight size={14} />
              <span>{tool.function?.name ?? tool.type}</span>
            </div>
          )) : <p className="muted">No MCP tools discovered.</p>}
        </div>
      ) : null}
    </aside>
  );
}

function ConversationList(props: {
  conversations: ConversationListResponse | null;
  onConversation: (conversation: ProviderConversation) => void;
}) {
  if (!props.conversations) return <p className="muted">Select a provider to load conversations.</p>;
  if (!props.conversations.supported) return <p className="muted">{props.conversations.reason ?? "Conversation listing is not supported."}</p>;
  if (!props.conversations.conversations?.length) return <p className="muted">No provider conversations returned.</p>;

  return (
    <div className="conversation-list">
      {props.conversations.conversations.map((conversation) => (
        <button key={conversation.id} onClick={() => props.onConversation(conversation)}>
          <strong>{conversation.title || "Untitled"}</strong>
          <small>{conversation.modelId ?? conversation.id}</small>
        </button>
      ))}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="error-banner">
      <ShieldAlert size={16} />
      <span>{message}</span>
      <button onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

function AuthBanner({ apiKey, onApiKey }: { apiKey: string; onApiKey: (apiKey: string) => void }) {
  const [value, setValue] = useState(apiKey);
  return (
    <div className="auth-banner">
      <ShieldAlert size={16} />
      <span>POLYCHAT_API_KEY is enabled. Store a local browser key to call protected endpoints.</span>
      <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="API key" type="password" />
      <button onClick={() => onApiKey(value)}>Save key</button>
    </div>
  );
}

function formatError(err: unknown): string {
  if (err instanceof PolychatApiError) return `${err.status}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
