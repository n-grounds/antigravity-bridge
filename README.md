# antigravity-bridge

A lightweight local OpenAI `/v1/` API server that seamlessly fulfills requests using the official Google Antigravity CLI (`agy`).

Turn any Antigravity-supported model into a drop-in OpenAI-compatible endpoint for tools like Python `openai`, Node.js `openai`, LangChain, LiteLLM, Continue, Aider, Open WebUI, LibreChat, Cursor, and any other OpenAI API client.

```
┌─────────────────────────────────────────────────────────────┐
│                 OpenAI API Compatible Client                │
│    (curl, openai-python, openai-node, LangChain, Aider)     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼ (POST http://127.0.0.1:17842/v1)
┌─────────────────────────────────────────────────────────────┐
│                     antigravity-bridge                      │
│                                                             │
│   • /v1/chat/completions (streaming SSE & non-streaming)   │
│   • /v1/models (catalog auto-sync from `agy models`)       │
│   • /v1/completions (text completions)                     │
│   • /v1/responses (OpenAI responses protocol)              │
└──────────────────────────────┬──────────────────────────────┘
                               │ (stdin/stdout stream-json)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                Google Antigravity CLI (`agy`)               │
│          (Gemini 3.8 Flash, Claude Sonnet 4.6, etc.)        │
└─────────────────────────────────────────────────────────────┘
```

---

## Features

- **OpenAI Standard Compatibility**: Supports `/v1/chat/completions` (streaming SSE and non-streaming), `/v1/models`, `/v1/models/{model}`, `/v1/completions`, and `/v1/responses`.
- **Automatic Model Discovery**: Dynamically synchronizes models available in `agy models` (e.g., `gemini-3.8-flash-high`, `claude-sonnet-4-6`, `gpt-oss-120b-medium`, etc.).
- **Real-Time Streaming**: Delivers streaming token deltas in standard OpenAI Server-Sent Events (`text/event-stream`) format with proper `data: [DONE]` termination.
- **Reasoning Effort Mapping**: Automatically maps `reasoning_effort` (`low`, `medium`, `high`, `xhigh`, `max`) to `agy --effort`.
- **Multimodal Support**: Inspects visual attachments (URLs, base64 data URIs, local files) using Antigravity's tools.
- **Stateless & Stateful**: Supports standard stateless conversation history (sending full `messages` array) as well as continuous sessions via `conversation_id`.

---

## Prerequisites

- **Node.js**: `>= 20.0.0`
- **Google Antigravity CLI (`agy`)**: Installed and authenticated (`agy models` must list available models).

---

## Quick Start

### 1. Verification

Run diagnostics to check your environment and detected `agy` installation:

```bash
node src/cli.mjs doctor
```

### 2. Start the Server

Start the local OpenAI `/v1` server (defaults to `127.0.0.1:17842`):

```bash
npm run serve
# or with custom options:
node src/cli.mjs serve --port 17842 --cwd "$PWD"
```

### 3. Test Endpoints

#### List Available Models:
```bash
curl http://127.0.0.1:17842/v1/models
```

#### Chat Completion (Non-Streaming):
```bash
curl http://127.0.0.1:17842/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash-high",
    "messages": [
      {"role": "user", "content": "Write a python one-liner to reverse a string"}
    ]
  }'
```

#### Chat Completion (Streaming):
```bash
curl -N http://127.0.0.1:17842/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash-high",
    "messages": [
      {"role": "user", "content": "Count from 1 to 5"}
    ],
    "stream": true
  }'
```

---

## Client Integration Examples

### Python (`openai`)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:17842/v1",
    api_key="none",  # local server does not require an API key
)

response = client.chat.completions.create(
    model="gemini-3.8-flash-high",
    messages=[
        {"role": "system", "content": "You are a concise coding assistant."},
        {"role": "user", "content": "Explain async/await in Python in two sentences."},
    ],
    stream=True,
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
print()
```

### Node.js (`openai`)

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:17842/v1",
  apiKey: "none",
});

const stream = await client.chat.completions.create({
  model: "gemini-3.8-flash-high",
  messages: [{ role: "user", content: "Hello Antigravity!" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

---

## Configuration & CLI Options

You can pass CLI arguments or environment variables:

| Option | Flag | Environment Variable | Default | Description |
|---|---|---|---|---|
| Port | `--port` | - | `17842` | Server port |
| Host | `--host` | - | `127.0.0.1` | Bind address |
| Working Directory | `--cwd` | - | Current directory | Working directory for `agy` execution |
| Mode | `--mode` | - | `accept-edits` | Agent execution mode (`accept-edits`, `auto`, `plan`) |
| AGY Path | `--agy-path` | `AGY_PATH` | auto-detected | Path to `agy` executable |
| Bridge Home | - | `ANTIGRAVITY_BRIDGE_HOME` | `~/.antigravity-bridge` | Configuration & cache storage |

---

## Running Tests

Run the test suite:

```bash
npm test
```

---

## License

MIT

---

## Acknowledgements

Forked from Jakevin/codex-bridge-antigravity:main on 2026-11-13

