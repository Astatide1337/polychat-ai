import type { ChatSession, WebSettings } from "./types";

const sessionsKey = "polychat.web.sessions";
const settingsKey = "polychat.web.settings";

export const defaultSettings: WebSettings = {
  baseUrl: "",
  apiKey: "",
  inspectorOpen: true,
  inspectorTab: "status",
};

export function loadSessions(): ChatSession[] {
  return readJson<ChatSession[]>(sessionsKey, []);
}

export function saveSessions(sessions: ChatSession[]): void {
  localStorage.setItem(sessionsKey, JSON.stringify(sessions));
}

export function loadSettings(): WebSettings {
  return { ...defaultSettings, ...readJson<Partial<WebSettings>>(settingsKey, {}) };
}

export function saveSettings(settings: WebSettings): void {
  localStorage.setItem(settingsKey, JSON.stringify(settings));
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}
