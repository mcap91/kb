# vLLM Setup Guide

How to install and serve vLLM as an OpenAI-compatible backend for kb-dispatch's Pi adapter
family (kb-dispatch's coding-agent backend), on WSL2 or native Linux (AWS/GCP GPU instances).

> **Verification status.** The WSL2 section is tested end-to-end: a 2026-09-02 baseline (vLLM
> 0.28.0) re-confirmed 2026-09-20 with vLLM 0.29.0 during kb's own dispatch smoke test
> (WK-0124). The AWS and GCP sections are **untested templates**. Every claim kb has not
> captured real evidence for is marked `[UNVERIFIED-SHAPE]` (DEC-0009: no hand-invented schemas
> or behavior — anything kb doesn't own is an assumption until proven, never guessed from
> memory). Treat those two sections as a starting point, not a verified procedure, and replace
> the markers with real findings the first time someone runs them.

## WSL2

### Tested configuration

| Component | Value | Source |
|---|---|---|
| GPU | RTX 5080 16GB (laptop) | 2026-09-02 baseline + WK-0124 (2026-09-20) |
| Windows driver | 610.47 | 2026-09-02 baseline |
| CUDA | 13.3 | 2026-09-02 baseline + WK-0124 (2026-09-20) |
| OS | Ubuntu 24.04 (WSL2) | WK-0124 (2026-09-20) |
| vLLM | 0.29.0 (0.28.0 in the 2026-09-02 baseline) | WK-0124 (2026-09-20) |
| Python | 3.11 (env) | WK-0124 (2026-09-20) |
| Pi (kb-dispatch's coding agent) | 0.85.1 | WK-0124 (2026-09-20) |

### Prerequisites

1. **NVIDIA driver on Windows** — 610.x or newer (needed for CUDA 13.3). Install it on the
   Windows side, not inside WSL2.
2. **WSL2 GPU passthrough working.** Confirm both sides see the same GPU before doing anything
   else:
   ```bash
   # Windows PowerShell
   nvidia-smi

   # WSL2 shell
   wsl nvidia-smi
   ```
   Both should print the same GPU.
3. **Conda or mamba inside WSL2** (e.g. Miniforge). Either works — the 2026-09-20 re-test used
   plain `conda`; the original 2026-09-02 baseline used `mamba` (a faster drop-in for conda).
4. **A C compiler.** vLLM's Triton JIT compiles kernels at runtime and fails without `gcc`:
   ```bash
   sudo apt update && sudo apt install -y gcc
   ```
5. **Python 3.11.** vLLM's dependency chain does not support Python 3.13 (confirmed
   2026-09-20) — create the environment with 3.11 explicitly.

### Install

```bash
conda create -n vllm python=3.11 -y
conda activate vllm
pip install vllm
```

`pip install vllm` pulls in torch and a matching CUDA runtime automatically — no separate
PyTorch or CUDA install is needed for this to work on WSL2.

### Serve

vLLM on WSL2 needs three workarounds — see Known Issues below for the underlying cause and
upstream tracking. Set the two environment variables before calling `vllm serve`:

```bash
export VLLM_USE_V2_MODEL_RUNNER=0
export VLLM_USE_FLASHINFER_SAMPLER=0

vllm serve <MODEL_ID> \
  --host 0.0.0.0 \
  --port 8000 \
  --max-model-len 16384 \
  --enable-auto-tool-choice \
  --tool-call-parser <PARSER>
```

Flag-by-flag:

- **`VLLM_USE_V2_MODEL_RUNNER=0` / `VLLM_USE_FLASHINFER_SAMPLER=0`** — required on WSL2 (Known
  Issues). Not expected to be needed on native Linux — see the AWS/GCP sections.
- **`--max-model-len 16384`** — caps the KV cache to fit in VRAM. The tested 16GB card OOMs at
  vLLM's larger default context because encoder profiling doesn't fit alongside model weights
  + KV cache. Raise this if your card has more headroom; lower it if you still OOM.
- **`--enable-auto-tool-choice --tool-call-parser <PARSER>`** — **required for kb-dispatch.**
  Pi sends `tool_choice: "auto"` on every request. Raw vLLM 0.29.0 rejects that with a 400
  error unless both flags are set (captured 2026-09-20, WK-0124 — see Known Issues). `<PARSER>`
  is model-family-specific — different models output tool calls in different formats, and vLLM
  needs to know which format to parse. See "Discovering the tool-call parser" below for how to
  find the right value for your model, and the verified/unverified parser table.

Wait for `Application startup complete` in the server log — roughly 90 seconds on first run
(kernel compilation + CUDA graph capture), about 30 seconds on later runs once kernels are
cached.

### Verify

```bash
curl http://localhost:8000/v1/models
```

This should return the model you started. The server is reachable from Windows at
`http://localhost:8000` (WSL2 forwards this automatically). Once this works, wire it into
kb-dispatch (below) and run a real dispatch before trusting it in production.

## AWS Linux (Ubuntu 24.04, GPU instances)

> **Untested template.** Nothing in this section has been run by kb. Each claim below is either
> a well-known platform fact carried over without a kb capture, or a direct analogy from the
> WSL2 evidence — neither is a substitute for testing on a real instance. Replace the markers
> with real findings the first time this is run end-to-end.

Target: GPU-backed instance families such as `g6` (NVIDIA L4) or `p5` (NVIDIA H100), running
Ubuntu 24.04 LTS.

### NVIDIA driver

AWS's GPU-oriented AMIs (e.g. the Deep Learning AMI / Deep Learning Base AMI families) ship
with the NVIDIA driver preinstalled. **`[UNVERIFIED-SHAPE]`** — kb has not confirmed this on a
live instance. Check before installing anything:

```bash
nvidia-smi
```

If that fails on a plain Ubuntu 24.04 AMI (no driver), you'll need to install one. The correct
driver package/version for your specific GPU + Ubuntu 24.04 combination is
**`[UNVERIFIED-SHAPE]`** — follow NVIDIA's or AWS's current driver install instructions rather
than a command copied from this doc; driver packaging changes often enough that a stale command
here would be actively harmful.

### CUDA toolkit

vLLM's pip package bundles the CUDA runtime components it needs to serve a model — a separate
system-wide CUDA Toolkit install is typically not required (this mirrors the WSL2 finding, where
the toolkit was only ever an *alternative* fix for the FlashInfer/`nvcc` issue, never a baseline
requirement). **`[UNVERIFIED-SHAPE]`** on native Linux specifically — the WSL2 result is the
closest evidence, not a native-Linux capture. If `vllm serve` reports a missing compiler or
`nvcc`, install both:

```bash
sudo apt update && sudo apt install -y gcc nvidia-cuda-toolkit
```

### Install vLLM

Same as WSL2:

```bash
conda create -n vllm python=3.11 -y
conda activate vllm
pip install vllm
```

### Serve

The three WSL2 workarounds exist because of a WSL2-specific limitation in UVA (CUDA's Unified
Virtual Addressing) — see Known Issues. Native Linux is the environment where UVA is normally
available, so these workarounds are **likely not needed here**. **`[UNVERIFIED-SHAPE]`** — kb
has not run vLLM on native Linux to confirm the V2 model runner and FlashInfer sampler work
without the environment-variable overrides. Start without them, and only add the WSL2
workarounds back if you hit the identical errors (`UVA is not available`, `Could not find
nvcc`) documented in Known Issues:

```bash
vllm serve <MODEL_ID> \
  --host 0.0.0.0 \
  --port 8000 \
  --max-model-len <TOKENS> \
  --enable-auto-tool-choice \
  --tool-call-parser <PARSER>
```

`--max-model-len`: size to your instance's actual VRAM and model. g6/p5 GPUs carry more VRAM
than the 16GB laptop card the WSL2 numbers were tuned for, so 16384 is not a starting point
here — **`[UNVERIFIED-SHAPE]`**, no tested value exists yet for these instance families. The
tool-calling flags are required for kb-dispatch on every platform (not WSL2-specific); the
parser value is **`[UNVERIFIED-SHAPE]`** exactly as in the WSL2 section above (not repeated
here).

### Verify

```bash
curl http://localhost:8000/v1/models
```

If connecting from off-instance, prefer SSH port-forwarding over opening the port in the
security group; widen network access only as far as your setup actually requires.

## GCP Linux (Ubuntu, GPU VMs)

> **Untested template.** Same caveat as the AWS section — nothing here has been run by kb. Treat
> every unmarked claim as carried over from general platform knowledge, not a kb capture.

Target: GPU-backed VM families such as `a3` (NVIDIA H100) or `g2` (NVIDIA L4), running Ubuntu
24.04 LTS.

### NVIDIA driver

GCP's "Deep Learning VM" images ship with the NVIDIA driver preinstalled; a plain Ubuntu 24.04
image does not, and needs the driver installed separately (Google publishes a driver-install
script for this). **`[UNVERIFIED-SHAPE]`** — kb has not confirmed either path on a live
instance. Check first:

```bash
nvidia-smi
```

If it fails, install the driver via GCP's own current instructions for your image and GPU
family rather than a command carried over from this doc.

### CUDA toolkit

Same expectation as AWS: vLLM's pip package should not need a separate CUDA Toolkit install to
serve a model. **`[UNVERIFIED-SHAPE]`** on native Linux/GCP specifically. If `vllm serve`
reports a missing compiler or `nvcc`:

```bash
sudo apt update && sudo apt install -y gcc nvidia-cuda-toolkit
```

### Install vLLM

```bash
conda create -n vllm python=3.11 -y
conda activate vllm
pip install vllm
```

### Serve

Same reasoning as AWS: the WSL2 UVA workarounds are **likely not needed** on native Linux.
**`[UNVERIFIED-SHAPE]`** — untested on GCP specifically. Start without them:

```bash
vllm serve <MODEL_ID> \
  --host 0.0.0.0 \
  --port 8000 \
  --max-model-len <TOKENS> \
  --enable-auto-tool-choice \
  --tool-call-parser <PARSER>
```

`--max-model-len` and `--tool-call-parser`: **`[UNVERIFIED-SHAPE]`**, same as the AWS section —
size and verify for your actual instance and model.

### Verify

```bash
curl http://localhost:8000/v1/models
```

## kb-dispatch backend config

Once vLLM is serving (any section above), point kb-dispatch at it. This config is repo-local
under `wiki/.dispatch/` in the repo you dispatch *from* — schema enforced by
`packages/dispatch-core/src/repo-config.ts`.

### `wiki/.dispatch/backends.json`

Add an entry keyed by whatever name you want to call this backend:

```json
{
  "vllm-local": {
    "family": "pi",
    "base_url": "http://localhost:8000/v1",
    "api_key_env": null,
    "secrets_file": null
  }
}
```

- **`family: "pi"`** — selects kb-dispatch's Pi adapter, which is what talks to vLLM's
  OpenAI-compatible endpoint.
- **`base_url`** — must be a real URL for the `pi` family; dispatch refuses (`BAD_RECORD`) if
  it's `null` here. Point it at your vLLM server's `/v1` path — swap `localhost:8000` for the
  instance's address if it's remote.
- **`api_key_env` / `secrets_file`** — both `null`. vLLM's OpenAI-compatible server has no auth
  by default, so there's no key to inject. This is the exact shape WK-0124 used against a real
  local vLLM instance.
- **Optional `serving.context_window`** — set this to match whatever `--max-model-len` you
  passed to `vllm serve`. Leave it out and dispatch defaults to 131072 tokens
  (`DEFAULT_CONTEXT_WINDOW` in `model-registry.ts`), which is wrong for a capped deployment and
  can let Pi assume more room than the server actually has. Known gap: dispatch also refuses
  (`BAD_RECORD`) any `serving.context_window` below 32768 (`MIN_CONTEXT_WINDOW` — Pi's own
  compaction logic needs at least 2x that as reserve), so a small card capped below 32768 — like
  the 16384 used in the WSL2 section's tested example — currently cannot express its true
  context window here at all. There's no resolution for that gap yet: either accept the
  inaccurate 131072 default, or leave it unset and watch for context-overflow errors.

### `wiki/.dispatch/models.json`

Add a matching model entry:

```json
{
  "qwen-0.5b-vllm": {
    "available_on": ["vllm-local"],
    "model_id": "Qwen/Qwen2.5-0.5B-Instruct",
    "tool_call_parser": "hermes"
  }
}
```

- **`available_on`** — the backend name(s) from `backends.json` that can serve this model slug.
- **`model_id`** — must match exactly what you passed to `vllm serve <MODEL_ID>`.
- **`tool_call_parser`** — the vLLM `--tool-call-parser` value for this model family. Required
  for vLLM models. Dispatch validates this field is non-empty if present (WK-0129). The
  operator starts vLLM with this value; dispatch stores it but does not consume it directly.
  See "Discovering the tool-call parser" below for how to find the right value.

### Dispatch to it

```bash
npm run dispatch -- --dir <repo> --handoff wiki/handoffs/HO-XXXX.md --model qwen-0.5b-vllm --backend vllm-local
```

or the `dispatch` MCP tool with the same `dir` / `handoff` / `model` / `backend` fields. Author
the handoff first (`create-handoff`) — dispatch requires an existing `HO-XXXX.md` to run
against.

## Discovering the tool-call parser for a new model

Different model families output tool calls in different formats. vLLM needs to know the
format via `--tool-call-parser`. The parser is per-model-family, not per-backend — if you
switch from Qwen to DeepSeek on the same vLLM server, you restart with a different parser.

### Verified parsers

These have been capture-tested end-to-end through kb-dispatch (Pi adapter → vLLM → tool
call → file write → streaming SSE captured in pi-output.log):

| Model family | Parser | Verified on | Evidence |
|---|---|---|---|
| Qwen 2.5 | `hermes` | vLLM 0.29.0, WSL2, RTX 5080 | WK-0124 HO-0032 capture (2026-09-20) |

### Unverified candidates

These parser names exist in vLLM 0.29.0's `--tool-call-parser` list and match the model
family by name, but kb has NOT capture-tested them. Do not use these without running
the discovery procedure below first.

| Model family | Candidate parser | Status |
|---|---|---|
| Qwen 3 | `qwen3_coder` or `qwen3_xml` | `[UNVERIFIED-SHAPE]` |
| DeepSeek V4 Flash | `deepseek_v4` | `[UNVERIFIED-SHAPE]` |
| Llama 4 | `llama4_json` or `llama4_pythonic` | `[UNVERIFIED-SHAPE]` |
| Mistral | `mistral` | `[UNVERIFIED-SHAPE]` |
| Gemma 4 | `gemma4` | `[UNVERIFIED-SHAPE]` |

### Discovery procedure

When you serve a new model family on vLLM for the first time, follow these steps to find
and verify the correct parser. This happens once per model family — record the result in
`models.json` so no one rediscovers it.

**Step 1 — List available parsers.**
```bash
vllm serve --help=Frontend 2>&1 | grep "tool-call-parser"
```
This prints all parser names your vLLM version supports.

**Step 2 — Pick a candidate.** Match the parser name to your model family. The name usually
contains the model family (e.g. `deepseek_v4` for DeepSeek V4, `qwen3_coder` for Qwen 3).
If no obvious match exists, check the model's documentation or HuggingFace page for its
tool-call format — many models document which format they use (Hermes, Mistral, etc.).

**Step 3 — Start vLLM with the candidate parser.**
```bash
vllm serve <MODEL_ID> --enable-auto-tool-choice --tool-call-parser <CANDIDATE> ...
```

**Step 4 — Dispatch a test handoff.** Use a trivial implement HO (e.g. "write a hello
function") — the task result doesn't matter, the capture does.
```bash
npm run dispatch -- --dir <repo> --handoff wiki/handoffs/HO-XXXX.md \
  --model <slug> --backend <vllm-backend>
```

**Step 5 — Check the result.** Three outcomes:
- **400 error** (`"auto" tool choice requires --enable-auto-tool-choice and
  --tool-call-parser to be set`) → the parser was not accepted. Try a different candidate.
- **Tool calls appear but are malformed** (Pi writes garbage, wrong paths, syntax errors
  in the tool call JSON) → the parser is wrong for this model. Try a different candidate.
- **Tool calls work** (Pi calls `write` with a real path and content, the file is created,
  `pi-output.log` shows `toolcall_start` → `toolcall_delta` → `toolcall_end` with valid
  JSON) → this parser is correct.

**Step 6 — Record it.** Add `tool_call_parser` to the model entry in
`wiki/.dispatch/models.json`:
```json
"my-model": {
  "available_on": ["vllm-backend"],
  "model_id": "org/Model-Name",
  "tool_call_parser": "<verified-parser>"
}
```
Commit this. Every future dispatch and every cold agent now knows the parser for this model.
Move the model from the "Unverified candidates" table above to the "Verified parsers" table
and cite the HO that proved it.

## Known issues

| Issue | Applies to | Error | Fix |
|---|---|---|---|
| V2 Model Runner requires UVA | WSL2 only (native Linux: `[UNVERIFIED-SHAPE]`, likely unaffected) | `RuntimeError: UVA is not available` | `export VLLM_USE_V2_MODEL_RUNNER=0` |
| Triton needs a C compiler | All platforms | `RuntimeError: Failed to find C compiler` | `sudo apt install gcc` |
| FlashInfer needs `nvcc` | WSL2 only (native Linux: `[UNVERIFIED-SHAPE]`, likely unaffected) | `RuntimeError: Could not find nvcc` | `export VLLM_USE_FLASHINFER_SAMPLER=0` |
| Tool calling rejected without explicit flags | All platforms — required for kb-dispatch | `400: "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set` | `--enable-auto-tool-choice --tool-call-parser <PARSER>` (parser value `[UNVERIFIED-SHAPE]` — see WSL2 section) |

**Upstream tracking (WSL2 UVA issue):** [vllm-project/vllm#50239](https://github.com/vllm-project/vllm/issues/50239),
[#54652](https://github.com/vllm-project/vllm/issues/54652), and an open, unmerged fix at
[PR #47579](https://github.com/vllm-project/vllm/pull/47579) (fall back to the V1 model runner
when UVA is unavailable). Once that PR merges, `VLLM_USE_V2_MODEL_RUNNER=0` should no longer be
necessary — re-test before removing it from this doc.

## Sources

- `bioinfo-agent-toolkit/docs/vllm-wsl2-setup.md` (sibling repo, not part of kb) — tested
  2026-09-02, vLLM 0.28.0. The WSL2 section above is derived from this doc.
- WK-0124 (2026-09-20) — kb's dispatch smoke test: error-path capture (tool_choice 400),
  happy-path capture (HO-0032, Qwen 2.5 0.5B, `hermes` parser verified), WK-0129 schema change.
- WK-0127 — the work item tracking this document.
- WK-0129 — `tool_call_parser` field added to models.json schema.
- DEC-0009 (kb's no-hand-invented-schemas rule) is why the AWS/GCP sections carry
  `[UNVERIFIED-SHAPE]` markers instead of asserted commands.
