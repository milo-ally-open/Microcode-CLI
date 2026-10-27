# Model provider capability matrix

This matrix describes the statically registered upstream model providers in `src/models/providers/` and the metadata exposed by the pinned `pi-ai` catalog. The current dependency is `@earendil-works/pi-ai` 0.87.1. Counts are a snapshot of that package's catalog and change only when the dependency or the reviewed adapter changes.

## Upstream providers

| Microcode provider ID | Authentication | Upstream API | Current catalog snapshot | Capability source |
|---|---|---|---|---|
| `openai-codex` | OAuth only | `openai-codex-responses` | 8 models | The pinned Codex provider catalog; each model's `input`, `reasoning`, context window, and output limit are returned by `getModelCatalog()`. |
| `openai` | API key only | `openai-responses` | 34 models | The pinned OpenAI catalog filtered to IDs starting with `gpt-`, excluding `gpt-realtime-*`; capabilities are per model. |
| `deepseek` | API key only | `openai-completions` | 2 models: `deepseek-flash`, `deepseek-v4-pro` | The pinned DeepSeek provider catalog; current metadata marks both as reasoning-capable, while image input is model-specific. |

The counts and feature flags above are catalog metadata, not a guarantee that every account, deployment, or future model endpoint supports every operation. Callers must use the selected model descriptor for image input, reasoning, context window, and output limits. The registry rejects provider IDs outside this table and validates each adapter's declared auth modes and APIs against its factory catalog.

The reviewed registrations are in `src/models/providers/openai-codex.ts`, `openai.ts`, and `deepseek.ts`; the allowlist and adapter validation are in `src/models/providers/index.ts` and `registry.ts`. `getModelCatalog()` is the client-safe source of current model IDs and metadata. It does not expose Pi provider objects, endpoints, or credentials.

## Gateway client protocols

These dialects are independent of the upstream API selected by a model:

| Gateway client dialect | Gateway route | Upstream provider implied? |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` | No. The selected `provider/model` determines the upstream API. |
| OpenAI Responses | `POST /v1/responses` | No. The selected `provider/model` determines the upstream API. |
| Gemini Generate Content | `POST /v1beta/models/{provider}/{model}:generateContent` and `:streamGenerateContent` | No. This does not register Google models or accept Google upstream credentials. |
| Anthropic Messages | `POST /v1/messages` | No. This does not register Anthropic models or accept Anthropic upstream credentials. |

Request/response features and unsupported fields are tracked separately in the [Gateway protocol capability matrix](protocol-capability-matrix.md). A client dialect must never be used as a provider allowlist or credential selector.

## Refreshing this matrix

When `pi-ai` or a provider registration changes:

1. Confirm the locked dependency version in `package.json` and `bun.lock`.
2. Inspect the pinned provider factory and its catalog; do not treat live upstream catalog data as runtime truth.
3. Run `getModelCatalog()` from the repository and update counts and model-specific capability notes here.
4. Verify the provider registration tests and auth/stream behavior for the changed adapter before describing the capability as accepted.

The machine-readable catalog remains authoritative for the full model list; this document records the reviewed provider/auth/API policy and the interpretation rules.
