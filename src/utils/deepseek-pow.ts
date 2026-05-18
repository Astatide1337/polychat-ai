/**
 * DeepSeekHashV1 Proof-of-Work solver.
 *
 * DeepSeek requires a PoW response header (`x-ds-pow-response`) on every
 * chat completion request. The challenge is issued by:
 *   POST /api/v0/chat/create_pow_challenge
 *
 * The algorithm is DeepSeekHashV1 — a custom non-standard Keccak variant.
 * DeepSeek ships the solver split across two webpack chunks:
 *   - 38401: webpack runtime + async entry point (calls u.x() to load 60816)
 *   - 60816: hash implementation + onmessage handler
 *
 * We run both scripts in a Node vm.Script context:
 *   1. Run the runtime script (38401) — sets up webpack and calls u.x()
 *   2. Run the hash chunk (60816) — webpack resolves the promise and sets onmessage
 *   3. Wait for microtasks to settle, then invoke the handler synchronously
 */

import { createContext, Script } from "node:vm";

const DS_POW_RUNTIME_URL = "https://fe-static.deepseek.com/chat/static/38401.a8c4129551.js";

// Module-level cache — downloaded once per process lifetime
let cachedRuntimeSrc: string | null = null;
let cachedHashSrc: string | null = null;

async function getRuntimeSrc(): Promise<string> {
  if (cachedRuntimeSrc) return cachedRuntimeSrc;
  const res = await fetch(DS_POW_RUNTIME_URL);
  if (!res.ok) throw new Error(`Failed to fetch DeepSeek PoW runtime script: ${res.status}`);
  let src = await res.text();
  // Disable Worker-only importScripts — not available in vm context
  src = src.replace(/u\.f\.i=\(t,e\)=>\{r\[t\]\|\|importScripts\(u\.p\+u\.u\(t\)\)\}/g, "u.f.i=(t,e)=>{void 0}");
  src = src.replace(/importScripts\([^)]*\);?/g, "void 0");
  cachedRuntimeSrc = src;
  return src;
}

async function getHashSrc(runtimeSrc: string): Promise<string> {
  if (cachedHashSrc) return cachedHashSrc;
  const baseMatch = runtimeSrc.match(/u\.p="([^"]+)"/);
  const chunkMatch = runtimeSrc.match(/u\.u=t=>"([^"]+)"\+t\+"([^"]+)"/);
  if (!baseMatch || !chunkMatch) throw new Error("DeepSeek PoW: could not extract chunk URL from runtime script");
  const chunkUrl = `${baseMatch[1]}${chunkMatch[1]}60816${chunkMatch[2]}`;
  const res = await fetch(chunkUrl);
  if (!res.ok) throw new Error(`Failed to fetch DeepSeek PoW hash chunk: ${res.status}`);
  cachedHashSrc = await res.text();
  return cachedHashSrc;
}

export interface DeepSeekChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  expire_at: number;
  expire_after: number;
  target_path: string;
}

export interface PoWAnswer {
  algorithm: string;
  challenge: string;
  salt: string;
  answer: number;
  signature: string;
}

/**
 * Solve a DeepSeekHashV1 PoW challenge.
 * Returns the answer object suitable for base64-encoding into `x-ds-pow-response`.
 */
export async function solveDeepSeekPoW(chal: DeepSeekChallenge): Promise<PoWAnswer> {
  const runtimeSrc = await getRuntimeSrc();
  const hashSrc = await getHashSrc(runtimeSrc);

  // Each solve gets a fresh context — the runtime's u.x() resolves asynchronously
  // via the webpack push mechanism, so we cannot share state across calls.
  const sandbox: Record<string, unknown> = {
    Buffer,
    Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
    Float32Array, Float64Array, ArrayBuffer, DataView,
    TextEncoder, TextDecoder, URL,
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise,
    console,
    importScripts: () => undefined,
    onmessage: null as unknown,
    postMessage: null as unknown,   // set below after context is live
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = createContext(sandbox);

  // Step 1: run the webpack runtime — sets up module registry, calls u.x() which
  // returns a Promise waiting for the hash chunk to be pushed.
  try { new Script(runtimeSrc).runInContext(ctx); } catch { /* async init error expected */ }

  // Step 2: run the hash chunk — pushes module 6008 into webpackChunk_deepseek_chat,
  // which webpack's push handler picks up, resolves the pending promise, and executes
  // module 6008 which sets sandbox.onmessage.
  try { new Script(hashSrc).runInContext(ctx); } catch { /* expected */ }

  // Step 3: allow microtasks to settle so the webpack Promise chain completes.
  await new Promise<void>((r) => setTimeout(r, 50));

  const handler = sandbox.onmessage as ((e: { data: unknown }) => void) | null;
  if (typeof handler !== "function") {
    throw new Error("DeepSeek PoW worker did not set onmessage — worker scripts may have changed");
  }

  return new Promise<PoWAnswer>((resolve, reject) => {
    let resolved = false;
    sandbox.postMessage = (msg: unknown) => {
      if (resolved) return;
      resolved = true;
      const m = msg as { type?: string; answer?: PoWAnswer; error?: unknown };
      if (m?.type === "pow-answer" && m.answer) {
        resolve(m.answer);
      } else if (m?.type === "pow-error") {
        reject(new Error(`DeepSeek PoW solver error: ${String(m.error)}`));
      }
    };

    handler({
      data: {
        type: "pow-challenge",
        challenge: {
          algorithm: chal.algorithm,
          challenge: chal.challenge,
          salt: chal.salt,
          signature: chal.signature,
          difficulty: chal.difficulty,
          expireAt: chal.expire_at,
          expireAfter: chal.expire_after,
          targetPath: chal.target_path,
        },
      },
    });

    // The solver runs synchronously inside the handler — if postMessage wasn't called,
    // it never will be.
    if (!resolved) {
      reject(new Error("DeepSeek PoW solver did not produce an answer synchronously"));
    }
  });
}

/**
 * Build the base64-encoded `x-ds-pow-response` header value from an answer.
 */
export function buildPowHeader(answer: PoWAnswer, targetPath: string): string {
  const payload = JSON.stringify({
    algorithm: answer.algorithm,
    challenge: answer.challenge,
    salt: answer.salt,
    answer: answer.answer,
    signature: answer.signature,
    target_path: targetPath,
  });
  return Buffer.from(payload).toString("base64");
}
