# LocalCouncil

A local web app where Anthropic Claude and OpenAI Codex (GPT-5.5) **debate together** in a group chat, with you in the room. No API keys, no per-token billing: it uses the **Claude Code CLI** and the **OpenAI Codex CLI** you already have signed in, so the models authenticate via the subscriptions you already pay for.

Built for people who like watching two strong models argue, push back on each other, and converge on a recommendation faster than either alone.

## What it does

- **Two LLMs in one chat.** Opus 4.7 and GPT-5.5 take turns replying. They see each other's messages and yours, address each other by name, and naturally disagree.
- **Per-LLM personality.** Click any model's card in the left sidebar to open a configurator: pick from 22 character traits (Strategist, Skeptic, Challenger, Diplomatic, Co-founder, Blunt, Decisive, ...) across thinking / disposition / communication categories, plus a freeform custom-instructions box. Combine up to 12 traits per model.
- **Polite interject.** Type a new message while a reply is in flight and the running model finishes its current turn naturally. Your message is added to the transcript immediately, the chain stops scheduling new turns after the current one, then both models respond to your interject.
- **Direct addressing.** Start a message with `opus,` / `claude,` / `gpt,` / `codex,` (or `@opus`, `@gpt`, etc.) and only that model replies, no auto-chain.
- **Multiple parallel chats** with shareable URLs (`/c/<slug>`). Switching chats does not interrupt the chain running in the others.
- **Arbiter mode.** Press "Synthesize" and a structured arbiter card summarizes the decision, rationale, rejected options, open questions, and proposed next tasks.
- **Worker dispatch (opt-in).** The arbiter can propose tasks for either model to execute as a *worker*: the CLI is spawned in a dedicated workspace, runs the task autonomously, and returns its output. After it finishes, the council automatically reviews what the worker produced. **See SECURITY below before enabling.**
- **Voice output.** Web Speech API TTS with per-role voice picker (Opus / GPT / Arbiter), speech-rate slider, optional auto-speak. Plus copy buttons on every message and a "copy entire discussion" button anchored at the bottom of the chat.
- **Custom providers.** Add other CLI tools (GLM, MiniMax, Kimi, anything that takes a prompt) or HTTP API endpoints (OpenAI-chat or Anthropic-messages compatible) from Settings. They join the chat alongside Opus and GPT with their own personality config. API providers read their key from an env var name you choose; the key itself is never persisted by LocalCouncil.

## Requirements

- **Node.js 18+**. The runtime only uses `express` and `ws`.
- **Claude Code CLI** signed in. Confirm with `claude auth status`. The chat reads no API keys; it spawns `claude -p --model opus ...` and relies on the CLI's OAuth session.
- **OpenAI Codex CLI** signed in. Confirm with `codex --version` and that you can run `codex exec -m gpt-5.5 ...` interactively. Same story: the chat spawns the CLI, no key reads.
- Tested on Windows 11 with PowerShell and on a stock Node setup. Should work on macOS and Linux with minor PATH adjustments.

## Install and run

```bash
git clone https://github.com/silverdolphin863/localcouncil
cd localcouncil
npm install
node server.js
```

Then open http://127.0.0.1:5757 in your browser.

The server binds to 127.0.0.1 only (localhost). It is not designed to be exposed on a LAN or the public internet.

### Auto-restart launcher (Windows)

`start-server.ps1` is a small PowerShell loop that runs `node server.js` and restarts it on crash, logging to `logs/server-YYYY-MM-DD.log`. Drop a shortcut to it in your Startup folder if you want LocalCouncil up at login.

## SECURITY

**Read this before turning on worker dispatch.**

LocalCouncil bundles two distinct surfaces with very different threat models.

### Chat (default, low risk)

- Server listens on `127.0.0.1` only.
- WebSocket connections are restricted to local origins (`127.0.0.1`, `localhost`, `[::1]`).
- All model and worker output is rendered through `marked.parse(...)` and then sanitized by DOMPurify before being inserted as HTML, so a model that emits `<script>` tags or other injection attempts will not execute in your browser.
- No authentication. Anyone with shell access to your machine can reach the chat. Same trust model as your shell history.

If you only use the chat features, that is the entire surface.

### Workers (opt-in, off by default)

The worker system spawns the **Claude Code CLI** or **Codex CLI** as a subprocess inside a per-task workspace under `workspaces/<conversation-id>/`. Workers are invoked with **permission bypass enabled** (`--permission-mode bypassPermissions` for Claude, `-s workspace-write` for Codex). That means a worker can:

- Read and write any file the CLI itself is authorized to access.
- Run arbitrary shell commands.
- Call out to the web through the CLI's web tools.

In practice the worker is asked to stay inside its workspace, and the worker prompt says so. But this is a *soft* constraint enforced by prompting, not a sandbox. If a worker decides to `cd ..` and `rm -rf` your home directory, nothing in this app will stop it. **Do not run worker dispatch on a machine with data you care about, on a shared workstation, or where you would not trust the CLI to act unsupervised.**

For that reason, **worker dispatch is OFF by default**. To enable:

```bash
# bash / macOS / Linux
LC_ALLOW_WORKER_BYPASS=1 node server.js

# PowerShell
$env:LC_ALLOW_WORKER_BYPASS = '1'; node server.js
```

When the flag is unset, dispatching a task posts a system message explaining how to enable it and the task is marked `blocked` instead of running.

### Reporting issues

If you find a security issue, please open a GitHub issue with the `security` label, or contact the maintainer directly if it is sensitive. Do not include exploit payloads in the public issue body.

## Configuration

Most config lives in `Settings` (top right) or the per-LLM dialog (click a card in the routing panel). Settings persist in `data/settings.json` and per-chat conversation history in `data/conversations/`. Both are gitignored.

Environment variables:

- `LC_ALLOW_WORKER_BYPASS=1` — enable worker dispatch. See SECURITY above.
- `PORT=5757` — HTTP/WS port (defaults to 5757).

## Roadmap

LocalCouncil ships today with two built-in CLI providers (Claude Code, Codex) plus user-added custom providers (CLI or HTTP API). Planned next:

- **Worker support for custom providers.** Today only the two built-in providers can run as workers. Generalizing worker dispatch across arbitrary CLIs needs more thought about each tool's permission model.
- **Stop-rule tuning UI.** The agreement-detection / runtime / error-count knobs are wired but not surfaced in settings yet.
- **Hardened worker sandbox.** Currently relies on the CLI's own permission flags and prompting. A real container or chroot-based isolation would let worker dispatch be on by default.

Contributions for any of the above are welcome.

## Tech

Pure Node + Express + `ws` on the backend; vanilla JS, HTML, CSS on the frontend with `marked` (for markdown) and `DOMPurify` (for sanitization) via CDN. No build step, no framework, no transpiler. The whole repo is around a dozen source files. You can read it in an evening.

## License

MIT.

## Not affiliated

LocalCouncil is not affiliated with Anthropic or OpenAI. "Claude", "Opus", "ChatGPT", "GPT-5.5", and "Codex" are trademarks of their respective owners. This project uses each company's published CLI as a regular end user would.
