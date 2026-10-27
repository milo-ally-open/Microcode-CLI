<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/microcode-logo-dark.png">
    <img src="assets/microcode-logo-light.png" alt="Microcode logo" width="128">
  </picture>
</p>

<h1 align="center">Microcode</h1>

<p align="center">
  A terminal-native AI coding assistant for understanding and changing code—built around a focused, keyboard-friendly TUI.
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#tui-input">TUI guide</a> ·
  <a href="#models-and-authentication">Models</a> ·
  <a href="#model-gateway">Model gateway</a> ·
  <a href="#skills-plugins-and-project-instructions">Extensibility</a>
</p>

## Features

- **Work in the terminal:** stream assistant responses alongside tool activity in a persistent conversation.
- **Understand and change code:** search and read project files, make edits, and run shell commands through configurable permission modes.
- **Choose your model:** use OpenAI Codex OAuth, OpenAI GPT API keys, or DeepSeek API keys; adjust thinking depth per request.
- **Extend the workflow:** load repository guidance, Skills, MCP servers, and Microcode plugins.
- **Pick up where you left off:** save sessions locally, resume them with rendered conversation history, and scroll through long runs.
- **Handle Git interactively:** inspect changes, manage branches and staging, commit, fetch, pull, push, and work with stashes.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Development setup](#development-setup)
- [TUI input](#tui-input)
- [Slash commands](#slash-commands)
- [Models and authentication](#models-and-authentication)
- [Model gateway](#model-gateway)
- [Skills, plugins, and project instructions](#skills-plugins-and-project-instructions)
- [MCP servers](#mcp-servers)
- [Permissions](#permissions)
- [Sessions](#sessions)
- [Release packages](#release-packages)

## Requirements

- [Bun](https://bun.sh) 1.3.14 or later to develop and build from source.
- A terminal with Unicode support. Some TUI interactions, including mouse-wheel scrolling, depend on terminal mouse-reporting support.

## Quick start

Build and install from a repository checkout:

```bash
bun install
bun run build
```

The build creates a standalone executable and installs it to:

| Platform | Install path |
|---|---|
| Linux / macOS | `~/.local/bin/microcode` |
| Windows | `%LOCALAPPDATA%\microcode\bin\microcode.exe` |

On Windows, add `%LOCALAPPDATA%\microcode\bin` to `PATH` if the build reports that the command is not available in your current shell. The executable has no Bun runtime dependency.

To run directly from source while developing:

```bash
bun run dev
```

Run tests with `bun test ./tests`.

To launch Microcode in the project you want to work on, first change to that project's directory, then run `microcode`.

### Development setup

For local development, clone the repository and install the locked dependencies:

```bash
git clone https://github.com/milo-ally/microcode.git
cd microcode
bun install --frozen-lockfile
bun run dev
```

Set the API key for your chosen provider in the environment, or use `/login` after starting the TUI. Run `bun test ./tests` before submitting changes; `bun run build` also verifies the standalone build and installs it to the user-level bin directory.

After installing, launch Microcode from the project you want to work on:

```bash
microcode                         # Start in the current directory
microcode --resume                # Resume the latest session for this directory
microcode --resume abc12345       # Resume a session by ID prefix
microcode --model openai-codex/gpt-5.6-luna
microcode --permission plan
microcode --thinking high
microcode --help
```

Other non-interactive commands:

```bash
microcode model list
microcode mcp list                 # List configured servers
microcode mcp list --scope project # Filter by scope: user, project, or all
microcode --version
```

## TUI input

| Input | Action |
|---|---|
| `/` | Browse slash commands; choose actions from the on-screen list |
| `$` | Find a Skill as soon as the character is typed; `$skill-name` includes its instructions in the request |
| `@` | Search for and attach workspace files to a request |
| `#` | Find an enabled plugin and include its description and invocable Skill guidance |
| `! command` | Run a shell command and show its output in the conversation |
| `!! command` | Run a shell command without adding its output to the Agent context |
| `Ctrl+V` / `Shift+Insert` | Attach an image from the clipboard when supported by the terminal and model |

Autocomplete menus appear above the input. While viewing older conversation history, use the mouse wheel or PageUp/PageDown to scroll continuously; select **Return to bottom** to follow the latest output again. The input and footer stay anchored while chat output grows.

## Slash commands

| Command | Description |
|---|---|
| `/help` | Show commands and keyboard shortcuts |
| `/clear` | Clear the current conversation view and Agent context |
| `/new` | Start a new conversation session |
| `/session` | Browse and load saved sessions |
| `/compact [instructions]` | Compress conversation context |
| `/export` | Export the current conversation as JSONL into `.microcode/sessions/` |
| `/status` | Show context usage, token statistics, and model details |
| `/model [provider/model]` | Browse, select, or switch models |
| `/thinking [level]` | Show or set thinking depth |
| `/permission [mode]` | Show or set the permission mode |
| `/login [provider]` | Sign in to a provider using the available authentication options |
| `/logout [provider]` | Sign out of a provider |
| `/auth` | Show provider authentication status |
| `/mcp` | Show MCP server status |
| `/skills` | Browse and manage Skills |
| `/plugins` | Browse plugins and enable or disable them by scope |
| `/git [action]` | Open the Git action menu or run a supported Git action |
| `/tasks` | Browse task lists and prioritize unfinished work in this session |
| `/instructions [reload]` | Show loaded project instructions or reload them |
| `/init` | Analyze the project and propose a `MICRO.md` project guide for review |
| `/exit` | Exit Microcode |

`/git` supports status, diffs, branches, add/stage, unstage, discard, commit, log, fetch, pull, push, and stash workflows. The interactive menus guide selection; remote and destructive actions require confirmation.

## Models and authentication

The initial upstream provider allowlist is intentionally small:

| Provider | Authentication | Environment variables |
|---|---|---|---|
| OpenAI Codex | Pi-managed OAuth | — |
| OpenAI GPT | `OPENAI_API_KEY` | `OPENAI_BASE_URL`, `OPENAI_MODEL` |
| DeepSeek | `DEEPSEEK_API_KEY` | `OPENAI_BASE_URL`, `DEEPSEEK_MODEL` |

Use `/login openai-codex` for Codex OAuth, or set the API key variable for OpenAI or DeepSeek. `BASE_URL` overrides the selected model's endpoint, and `MODEL` selects the default model. Generic `API_KEY` and keys for other upstream providers are not used. Built-in model metadata and authentication flows come from the Pi version pinned by this repository. Run `microcode model list` to see the catalog available in your build.

### Custom models

Legacy custom model entries in `~/.microcode/config.json` or `.microcode/config.json` are retained, but the current provider allowlist disables them. Microcode reports a diagnostic when it finds these entries; they are not listed or used for inference. The example below documents the existing config shape for migration/reference only:

```json
{
  "models": [
    {
      "id": "my-model",
      "name": "My Model",
      "api": "openai-completions",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "MY_API_KEY",
      "reasoning": false,
      "input": ["text"],
      "contextWindow": 128000,
      "maxTokens": 4096
    }
  ]
}
```

The supported custom-model `api` values and fields belong to the legacy config format. These models are not currently available in `/model` or `microcode model list`. See [the runtime architecture model-provider guide](docs/specs/runtime-architecture/model-provider-guide.md) for the approved provider policy and the reviewed path for adding support.

See [the model integration and gateway spec](docs/specs/model_intergration_spec.md) for the model catalog, authentication, direct integration, and harness-independent gateway design.

## CLI runtime and Model Gateway

By default, `microcode` starts or reuses a project-scoped Bun runtime service on an authenticated loopback endpoint. That service owns the Agent, model/provider access, tools, permissions, session persistence, Skills, MCP, and Plugin lifecycle; the Chalk TUI communicates with it through versioned HTTP commands and an SSE event stream. If the runtime cannot start or connect, Microcode reports the error and exits. Use `microcode --no-daemon` to run the Agent and its session in the current process.

The CLI also starts or connects to the separate Model Gateway for provider catalog and authentication controls. The Gateway remains available to external clients that need OpenAI Chat Completions, OpenAI Responses, Gemini Generate Content, or Anthropic Messages compatibility. It does not own a Microcode TUI session or execute Microcode tools. Gateway bind settings and security limits below apply only to that external API service; the local runtime API always binds to loopback and uses a separate token.

The initial service listens on `127.0.0.1:43127`. Host and port can be configured independently. For each setting, precedence is command-line option, environment variable, `~/.microcode/config.json`, then the default:

| Setting | CLI | Environment | User config | Default |
|---|---|---|---|---|
| Bind address | `--gateway-host <HOST>` | `MICROCODE_GATEWAY_HOST` | `gateway.host` | `127.0.0.1` |
| Port | `--gateway-port <PORT>` | `MICROCODE_GATEWAY_PORT` | `gateway.port` | `43127` |

The host must be an IP address or hostname without a scheme or port. Use `127.0.0.1` for this computer only, a specific local address such as `192.168.1.20` to listen on one interface, or `0.0.0.0` to listen on all IPv4 interfaces. For a persistent user-level configuration, merge this top-level section into `~/.microcode/config.json` (preserve any existing settings):

```json
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 43127
  }
}
```

For a one-time bind-address override, start with `microcode gateway start --gateway-host 0.0.0.0`. In the TUI, `/gateway` opens the address picker; `/gateway 192.168.1.20` sets an address directly. Changing the address persists `gateway.host`, restarts the daemon, and checks the handshake. A specific address must be assigned to this machine. If a daemon is already running on another address or port, Microcode reports the conflict and does not replace it silently. Gateway state and owner-only tokens are stored under `~/.microcode/daemon/`.

For a persistent private-network listener, set `"host": "0.0.0.0"` in the JSON above (or set `MICROCODE_GATEWAY_HOST=0.0.0.0`) and keep the port restricted to trusted clients with the server firewall.

```bash
microcode gateway status
microcode gateway start
microcode gateway token  # explicitly prints the client token
microcode gateway token --rotate  # rotate while stopped, then print the new client token
microcode gateway stop
```

The service exposes `GET /v1/models`, OpenAI Chat Completions at `/v1/chat/completions`, OpenAI Responses at `/v1/responses`, Anthropic Messages at `/v1/messages`, and the supported Gemini Generate Content subset at `/v1beta/models/{provider}/{model}:generateContent` and `:streamGenerateContent`. Use the printed gateway token as Bearer auth for OpenAI clients, `x-api-key` for Anthropic clients, or `x-goog-api-key` for Gemini clients. Gemini uses the same `provider/model` IDs returned by `/v1/models`. Its current adapter supports text, inline base64 images when the selected model accepts images, function tools, basic generation settings, and SSE generation; structured JSON outputs, forced function selection, and unsupported modalities return a clear error. The public token is separate from upstream provider credentials and the private TUI RPC token. Stop the gateway before rotating the public token; rotation refuses to invalidate credentials used by a running daemon.

Example Gemini-compatible request using a DeepSeek model from the gateway catalog:

```bash
curl --fail http://127.0.0.1:43127/v1beta/models/deepseek/deepseek-v4-pro:generateContent \
  -H "x-goog-api-key: $MICROCODE_GATEWAY_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"contents":[{"role":"user","parts":[{"text":"Explain what a reverse proxy does in one sentence."}]}]}'
```

### Use Microcode as a local or private-network API relay

The gateway separates upstream model authentication from client authentication:

1. Sign in to the model provider in Microcode with `/login <provider>` (or configure that provider's API-key environment variable). The gateway uses these Microcode-managed credentials for upstream requests; client applications do not receive them.
2. Start the persistent service with `microcode gateway start` and check it with `microcode gateway status`. It stays available after the TUI exits. It is loopback-only by default. To make it reachable from another machine on a trusted network, bind all IPv4 interfaces (or just the server's LAN address):

   ```bash
   microcode gateway start --gateway-host 0.0.0.0
   # or: microcode gateway start --gateway-host 192.168.1.20
   ```

   Then use the server's reachable address—not `0.0.0.0`—in remote client URLs, for example `http://192.168.1.20:43127`. Allow the port only on the intended private network in the host firewall.
3. Read the client token with `microcode gateway token`. Treat it as a secret. Find an exact model ID with the authenticated `GET /v1/models` endpoint; use its `id` value (usually `provider/model`) in requests.

```bash
export MICROCODE_GATEWAY_TOKEN="$(microcode gateway token)"
curl --fail http://127.0.0.1:43127/v1/models \
  -H "Authorization: Bearer $MICROCODE_GATEWAY_TOKEN"
```

For example, after setting `MICROCODE_GATEWAY_TOKEN` to the token printed by `microcode gateway token`, the OpenAI Python SDK can call the gateway's Chat Completions endpoint:

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:43127/v1",
    api_key=os.environ["MICROCODE_GATEWAY_TOKEN"],
)

result = client.chat.completions.create(
    model="deepseek/deepseek-v4-pro",  # Replace with an id from GET /v1/models.
    messages=[{"role": "user", "content": "Explain what a reverse proxy does in one sentence."}],
)
print(result.choices[0].message.content)
```

The Anthropic Python SDK can use the Anthropic Messages endpoint in the same way. Its `api_key` here is the **Microcode gateway token**, not an Anthropic API key:

```python
import os
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:43127",
    api_key=os.environ["MICROCODE_GATEWAY_TOKEN"],
)

message = client.messages.create(
    model="deepseek/deepseek-v4-pro",  # Replace with an id from GET /v1/models.
    max_tokens=256,
    messages=[{"role": "user", "content": "Explain what a reverse proxy does in one sentence."}],
)
for block in message.content:
    if block.type == "text":
        print(block.text)
```

Install the corresponding SDK in your Python environment (`pip install openai` or `pip install anthropic`). For a client on another machine, replace `127.0.0.1` in the examples with the gateway server's reachable LAN address; OpenAI uses a base URL ending in `/v1`, while Anthropic uses the gateway origin. The endpoint dialect is selected by the SDK route; the chosen upstream model must support the requested capabilities, and unsupported protocol options are rejected rather than silently translated.

**Public-network security:** binding to `0.0.0.0` only opens a listener; it does not add TLS, per-client identities/tokens, rate limits, quotas, or multi-tenant isolation. The current gateway has one shared client token. Do not expose its port directly to the public Internet. For remote use, put it behind a separately secured VPN or TLS/reverse-proxy layer, restrict inbound network access, and protect/rotate the gateway token. Do not assume a vendor's consumer subscription permits API relaying; use only provider authorization and inference flows explicitly supported for that use.

These endpoints are protocol adapters under active development. Passing Microcode's fake-runtime contract tests does not by itself certify a specific Codex, Claude Code, or DeepSeek client/version; consult the spec for current compatibility gates and known unsupported request options. The gateway does not execute client tools or expose Microcode workspace tools.

## Skills, plugins, and project instructions

### Skills

Skills are directories containing a `SKILL.md` file. Microcode discovers:

- User Skills in `~/.microcode/skills/`
- Project Skills in `.microcode/skills/`
- Built-in Skills managed by Microcode

Project Skills take precedence over user Skills with the same name; built-in names are reserved. Type `$` to browse available Skills, then select one. Plugin Skills use the namespaced form `$plugin-name:skill-name`. A Skill adds instructions to that request; it does not grant additional tool permissions.

### Plugins

Microcode plugins are packages that can bundle Skills and MCP server definitions. They are discovered from:

- User: `~/.microcode/plugins/<plugin-name>/`
- Project: `.microcode/plugins/<plugin-name>/`

A package has a `plugin.json` manifest and may include a `skills/` directory and/or an `mcp.json` file. For example:

```text
my-plugin/
├── plugin.json
├── mcp.json          # optional
└── skills/           # optional
    └── review/
        └── SKILL.md
```

The required manifest fields are `name` (lowercase kebab-case), `version` (semantic version), and `description`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "A short description of this package"
}
```

Use `/plugins` to inspect the list and choose which plugins are enabled in each scope. Packages are disabled unless enabled in Microcode. Only the documented package components are loaded; plugin manifests do not run arbitrary hooks or commands. Plugin Skills and MCP servers are namespaced, and plugin-provided MCP servers are connected when their plugin is enabled.

### Project instructions

Microcode loads `AGENTS.md`, `CLAUDE.md`, and `MICRO.md` files from the project root down to the current working directory, subject to a combined size limit. `/instructions` shows the loaded files; `/instructions reload` discovers them again. `/init` proposes a `MICRO.md` guide and asks before applying it.

## MCP servers

Standalone MCP configuration can live in `~/.microcode/config.json` or `.microcode/config.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["path/to/server.js"]
    }
  }
}
```

Directory packages are also supported: put an `mcp.json` containing an `mcpServers` object under `~/.microcode/mcp/<package>/` or `.microcode/mcp/<package>/`. Supported transports include local stdio and secure remote MCP endpoints. Microcode discovers and connects configured servers at startup; `/mcp` shows runtime status and `microcode mcp list` lists discovered configuration. MCP tools still follow Microcode's permission policy. MCP `env` and `headers` values are stored as configuration strings: keep credentials in local, untracked configuration and do not commit them.

The Agent starts with a small tool set: file read/write/edit, shell, grep/glob, Ask, Skill, and tool search. Other built-in tools such as web search/fetch, vision, task, and worktree are registered but disabled by default. The Agent can use `tool_control` to list its registered tool IDs and enable or disable a tool for the current session. This only changes tool availability; every execution still follows the normal permission policy.

## Permissions

The default `interactive` mode allows reads and asks before write, edit, and shell operations. Set a mode at launch with `--permission` (or `--permission-mode`) or change it with `/permission`:

| Mode | Behavior |
|---|---|
| `interactive` | Ask before write/edit/shell operations |
| `auto-approve` | Run tools without interactive approval prompts |
| `plan` | Read-only; block write, edit, and shell operations |

Review tool requests and permission prompts before approving them, especially when using external MCP servers.

## Sessions

Sessions are stored locally under `~/.microcode/sessions/`. `microcode --resume` opens the latest session for the current working directory; `microcode --resume <id-prefix>` opens a matching session. Resumed messages are rendered in the conversation immediately and can be browsed with the mouse wheel or PageUp/PageDown. Use `/session` to choose from saved sessions or `/new` to begin another conversation.

To analyze an exported session's user turns, tool outcomes, token usage, and trajectory, install Matplotlib and run:

```bash
python3 -m pip install matplotlib
python3 scripts/analyze.py .microcode/sessions/session-SESSION_ID.jsonl
```

Replace `SESSION_ID` with the exported filename's ID. The dashboard and `-trajectory.png` chart are written under `.microcode/analysis/` by default. Pass `--output <PATH>` to choose a different dashboard path. The charts summarize metadata and do not render conversation text or tool arguments.

## Release packages

The CLI/TUI package scripts are in `packaging/`:

```bash
bun run package:cli
```

Artifacts are written to `packaging/out/` as platform-specific `.tar.gz` (Linux/macOS) or `.zip` (Windows) packages. Build on each target operating system for a native executable. See [packaging/README.md](packaging/README.md) for install details.
