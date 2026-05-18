import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeStorageState } from "../browser/profile.js";
import { getSessionDir } from "../config/index.js";
import { encrypt, decrypt, getEncryptionKey } from "./crypto.js";

function sessionPath(provider: string) {
  return join(getSessionDir(), `${provider}.enc`);
}

function ensureParent(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function saveSession(provider: string, storageState: Record<string, unknown>) {
  const payload = JSON.stringify(storageState);
  const encrypted = encrypt(payload, getEncryptionKey());
  const filePath = sessionPath(provider);
  ensureParent(filePath);
  writeFileSync(filePath, encrypted);
}

export function loadSession(provider: string): Record<string, unknown> | null {
  const filePath = sessionPath(provider);
  if (!existsSync(filePath)) return null;
  const encrypted = readFileSync(filePath);
  const plaintext = decrypt(encrypted, getEncryptionKey());
  const parsed = JSON.parse(plaintext) as Record<string, unknown>;
  if (Array.isArray(parsed.cookies) && Array.isArray(parsed.origins)) {
    return normalizeStorageState(parsed);
  }
  return parsed;
}

export function deleteSession(provider: string) {
  const filePath = sessionPath(provider);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

export function hasSession(provider: string) {
  return existsSync(sessionPath(provider));
}
