// Canonical kb-shipped blackboard agent adapter for local models.
//
// Bridges a toolless local model (Ollama, or any OpenAI/Ollama-compatible
// endpoint) into the kb Dispatch Protocol — the "Local Model Agents" path in
// docs/dispatch-protocol.md. Register it in launchers.v1.json:
//
//   "qwen3-coder-30b": {
//     "base_argv": ["node", "<abs path to this file>"],
//     "instruction_transport": { "kind": "stdin" },
//     "response_transport": { "kind": "stdout_capture" },
//     "env": { "OLLAMA_MODEL": "qwen3-coder:30b" }
//   }
//
// It reads the reviewed bundle via AGENT_BLACKBOARD_* env, calls the model, and
// writes the answer to stdout (stdout_capture transport); logs go to stderr.
// Exits non-zero on any failure so the launcher fails closed.
//
// Model + endpoint are registry-parameterized via env (OLLAMA_MODEL / OLLAMA_URL
// / OLLAMA_NUM_CTX), so one adapter serves any local model — or a remote
// OpenAI/Ollama-compatible worker — by editing the registry, not this file.
// Plain .mjs (node, global fetch) on purpose: no tsx/build step to resolve
// inside dispatch's filtered launch environment.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3-coder:30b";
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 8192);

const log = (...a) => console.error("[blackboard-agent-ollama]", ...a);

function fail(msg) {
  log("FAIL:", msg);
  process.exit(1);
}

/** Read every file in the reviewed context/ dir as reference material (best-effort). */
async function readContext(dir) {
  if (!dir) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      files.push({ name: e.name, body: await readFile(join(dir, e.name), "utf-8") });
    } catch {
      /* skip unreadable */
    }
  }
  return files;
}

async function main() {
  const handoffPath = process.env.AGENT_BLACKBOARD_HANDOFF_PATH;
  if (!handoffPath) fail("AGENT_BLACKBOARD_HANDOFF_PATH not set — run me via kb dispatch.");

  let task;
  try {
    task = await readFile(handoffPath, "utf-8");
  } catch (e) {
    return fail(`cannot read handoff at ${handoffPath}: ${e.message}`);
  }

  const context = await readContext(process.env.AGENT_BLACKBOARD_CONTEXT_DIR);
  const contextBlock = context.length
    ? "\n\n# Reference context (read-only)\n" +
      context.map((c) => `\n## ${c.name}\n${c.body}`).join("\n")
    : "";

  const system =
    "You are a focused coding worker dispatched through a reviewed handoff. " +
    "Do exactly the task in the handoff — nothing more. Return the solution " +
    "directly: code in fenced blocks, minimal prose, no preamble.";
  const user = `# Handoff (your task)\n${task}${contextBlock}`;

  log(
    `model=${MODEL} url=${OLLAMA_URL} num_ctx=${NUM_CTX} ` +
      `handoff_bytes=${task.length} context_files=${context.length}`,
  );

  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        options: { num_ctx: NUM_CTX, temperature: 0.7, top_p: 0.8 },
      }),
    });
  } catch (e) {
    return fail(`cannot reach Ollama at ${OLLAMA_URL} — is it serving? (${e.message})`);
  }

  if (!res.ok) return fail(`Ollama HTTP ${res.status}: ${await res.text()}`);

  const json = await res.json();
  const answer = json?.message?.content ?? "";
  if (!answer.trim()) return fail("model returned an empty answer.");

  const ms = Date.now() - startedAt;
  const evalCount = json.eval_count ?? 0;
  const evalSec = (json.eval_duration ?? 0) / 1e9;
  const tps = evalSec > 0 ? (evalCount / evalSec).toFixed(1) : "?";
  log(`done in ${ms} ms — ${evalCount} tok @ ${tps} tok/s`);

  // stdout is the launcher-owned response (stdout_capture transport).
  process.stdout.write(answer);
}

main().catch((e) => fail(e?.stack ?? String(e)));
