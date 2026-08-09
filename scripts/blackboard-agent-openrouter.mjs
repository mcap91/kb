// Canonical kb-shipped blackboard agent adapter for OpenRouter.
//
// Twin of blackboard-agent-ollama.mjs, but targets OpenRouter's OpenAI-format
// endpoint (/api/v1/chat/completions), which serves EVERY OpenRouter model
// (GPT, Gemini, Claude, GLM, DeepSeek, Qwen, Grok, ...). One adapter → any
// model, selected per run via OPENROUTER_MODEL. Register in launchers.v1.json:
//
//   "openrouter": {
//     "base_argv": ["node", "<abs path to this file>"],
//     "instruction_transport": { "kind": "stdin" },
//     "response_transport": { "kind": "stdout_capture" },
//     "read_only": { "supported": true, "argv_suffix": ["--read-only"], "response_writable": true },
//     "env": { "OPENROUTER_MODEL": "z-ai/glm-5.2" }
//   }
//
// The adapter is structurally read-only w.r.t. the repo: it only reads the
// reviewed bundle, calls the model, and writes the answer to stdout. It never
// edits the repo (implement-mode output is returned as text for the operator to
// apply, same as the ollama adapter). The "--read-only" argv sentinel exists so
// the launcher's redteam gate (registry.ts: non-empty argv_suffix) is satisfied;
// the script ignores extra argv.
//
// The API key is NEVER stored in the registry or the repo. It is read from
// $OPENROUTER_API_KEY, else from ${CLAUDE_ARMS_DIR:-~/.claude/arms}/secrets.env
// (the same file the claude-or launcher uses). Plain .mjs (node, global fetch)
// on purpose: no tsx/build step inside dispatch's filtered launch environment.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const MODEL = process.env.OPENROUTER_MODEL;
const TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS ?? 1_200_000);

const log = (...a) => console.error("[blackboard-agent-openrouter]", ...a);

class FailError extends Error {}
// Throw rather than process.exit(): an abrupt exit while a fetch/timer handle is
// still open trips a libuv assertion on Windows and can scramble the exit code.
// The top-level catch sets exitCode so the launcher still fails closed.
function fail(msg) {
  throw new FailError(msg);
}

/** Read OPENROUTER_API_KEY from env, else parse it out of arms/secrets.env. */
async function readApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const armsDir = process.env.CLAUDE_ARMS_DIR ?? join(homedir(), ".claude", "arms");
  const secretsPath = join(armsDir, "secrets.env");
  let raw;
  try {
    raw = await readFile(secretsPath, "utf-8");
  } catch (e) {
    fail(`OPENROUTER_API_KEY not set and cannot read ${secretsPath}: ${e.message}`);
  }
  for (const line of raw.split(/\r?\n/)) {
    const noComment = line.split("#", 1)[0].trim();
    if (!noComment) continue;
    const eq = noComment.indexOf("=");
    if (eq === -1) continue;
    const key = noComment.slice(0, eq).trim();
    if (key !== "OPENROUTER_API_KEY") continue;
    return noComment.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return fail(`OPENROUTER_API_KEY not found in ${secretsPath}`);
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
  if (!MODEL) fail("OPENROUTER_MODEL not set — set it in the registry env or the launch environment.");

  const handoffPath = process.env.AGENT_BLACKBOARD_HANDOFF_PATH;
  if (!handoffPath) fail("AGENT_BLACKBOARD_HANDOFF_PATH not set — run me via kb dispatch.");

  let task;
  try {
    task = await readFile(handoffPath, "utf-8");
  } catch (e) {
    return fail(`cannot read handoff at ${handoffPath}: ${e.message}`);
  }

  const apiKey = await readApiKey();
  const context = await readContext(process.env.AGENT_BLACKBOARD_CONTEXT_DIR);
  const contextBlock = context.length
    ? "\n\n# Reference context (read-only)\n" +
      context.map((c) => `\n## ${c.name}\n${c.body}`).join("\n")
    : "";

  const system =
    "You are a rigorous agent dispatched through a reviewed handoff. Do exactly " +
    "the task defined in the handoff — nothing more. Return your final response " +
    "directly, with no preamble.";
  const user = `# Handoff (your task)\n${task}${contextBlock}`;

  log(`model=${MODEL} base=${BASE_URL} handoff_bytes=${task.length} context_files=${context.length}`);

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/kb-dispatch",
        "X-Title": "kb-dispatch",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    return fail(`cannot reach OpenRouter at ${BASE_URL} (${e.name}: ${e.message})`);
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await res.text();
  if (!res.ok) return fail(`OpenRouter HTTP ${res.status}: ${bodyText}`);

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (e) {
    return fail(`cannot parse OpenRouter response: ${e.message} — body: ${bodyText.slice(0, 500)}`);
  }

  const answer = json?.choices?.[0]?.message?.content ?? "";
  if (!answer.trim()) {
    return fail(`model returned no content. Raw: ${JSON.stringify(json).slice(0, 800)}`);
  }

  const ms = Date.now() - startedAt;
  const usage = json.usage ?? {};
  log(`done in ${ms} ms — prompt=${usage.prompt_tokens ?? "?"} completion=${usage.completion_tokens ?? "?"} tokens`);

  // stdout is the launcher-owned response (stdout_capture transport).
  process.stdout.write(answer);
}

main().catch((e) => {
  log("FAIL:", e instanceof FailError ? e.message : (e?.stack ?? String(e)));
  process.exitCode = 1;
});
