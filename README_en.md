# FreeQwenApi

> 🌐 **English** | [Русский](README.md) | [Tiếng Việt](README_vi.md)

> **Local OpenAI-compatible proxy to Qwen Chat**
> Text, Qwen 3.7 models, files, Open WebUI, Hermes/LiteLLM, and now image and video generation via Qwen Chat.

![API](https://img.shields.io/badge/API-OpenAI--compatible-green)
![Qwen](https://img.shields.io/badge/Qwen-Chat-purple)

## What is this

FreeQwenApi turns the Qwen Chat web app into a local API endpoint:

```text
http://localhost:3264/api
```

This is **not a local model running on your GPU** and **not the official Alibaba/Qwen API**. It's a practical browser-based proxy: you log in to Qwen Chat, the project captures the session, and gives you a local OpenAI-compatible API for your integrations.

## Fork features

- **Chat Completions API**: `POST /api/chat/completions`, compatible with OpenAI SDK, Open WebUI, LiteLLM, and agents.
- **Current Qwen Chat models**: `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus` and other models from `src/AvailableModels.txt`.
- **Image generation via Qwen Chat**: `POST /api/images/generations` without `DASHSCOPE_API_KEY`.
- **Video generation via Qwen Chat**: `POST /api/videos/generations` + task polling via `GET /api/tasks/status/:taskId`.
- **Multi-account**: add, re-login, remove, check `OK` / `WAIT` / `INVALID` status, automatic round-robin rotation on rate limits.
- **File uploads**: upload endpoint for Qwen files and attachments.
- **Open WebUI**: can connect as OpenAI-compatible backend.
- **Hermes Agent / LiteLLM / Claude Code**: ready configs for local AI agents.
- **Health/smoke tooling**: `/api/health`, `/api/status`, `/api/models`, `npm run smoke`, `npm run models:sync`.
- **ForgetMeAI branding**: watermark `t.me/forgetmeai` in README, CLI, and health/media metadata.

## Quick start

```bash
git clone https://github.com/ForgetMeAI/FreeQwenApi
cd FreeQwenApi
npm install
npm run auth
npm run models:sync
SKIP_ACCOUNT_MENU=true npm start
```

In another terminal:

```bash
npm run smoke
```

If everything is fine, API is available here:

```text
http://localhost:3264/api
```

## Configuration

All settings are set via environment variables. Full list with defaults and comments — in [`.env.example`](.env.example): port, default model, timeouts, limits, paths, logging, Chrome path, etc.

Variables can be set from the environment directly. Set the ones you need however you like:

```bash
export PORT=3264 DEFAULT_MODEL=qwen3.7-max   # bash
$env:PORT=3264; npm start                    # PowerShell
```

Or via `environment:` block in `docker-compose.yml` / `-e` flags with `docker run`.

## Qwen Chat authorization

Add account:

```bash
npm run auth
```

Or specific action:

```bash
npm run auth -- --add
npm run auth -- --list
npm run auth -- --relogin
npm run auth -- --remove
```

When adding an account, Chromium opens. Log in to Qwen Chat, then return to terminal — token will be saved in `session/`.

**Do not commit or publish these files:**

- `session/`
- `session/tokens.json`
- `session/accounts/**/token.txt`
- `.env`
- `Authorization.txt`
- cookies / browser profile / real tokens

## Main endpoints

### Health

```bash
curl http://localhost:3264/api/health
```

Returns service, count of models, accounts, and watermark:

```json
{
  "ok": true,
  "service": "FreeQwenApi",
  "watermark": "t.me/forgetmeai",
  "baseUrl": "/api",
  "models": 28
}
```

### Model list

```bash
curl http://localhost:3264/api/models
```

Update model list from Qwen Chat metadata:

```bash
npm run models:sync
```

Detailed report: [docs/QWEN_CHAT_MODELS.md](docs/QWEN_CHAT_MODELS.md)

### Chat Completions

```bash
curl http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "messages": [
      {"role": "user", "content": "Answer briefly: what is FreeQwenApi?"}
    ],
    "stream": false
  }'
```

OpenAI SDK:

```js
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3264/api',
  apiKey: 'dummy-key'
});

const response = await openai.chat.completions.create({
  model: 'qwen3.7-max',
  messages: [{ role: 'user', content: 'Hello!' }]
});

console.log(response.choices[0].message.content);
```

## Image generation via Qwen Chat

By default `/api/images/generations` uses **Qwen Chat**, not DashScope. That means separate `DASHSCOPE_API_KEY` is not needed — you need an active Qwen Chat account.

```bash
curl http://localhost:3264/api/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Cyberpunk fox in neon Tokyo, sci-fi poster style",
    "model": "qwen3-vl-plus",
    "size": "16:9"
  }'
```

Example response:

```json
{
  "created": 1770000000,
  "watermark": "t.me/forgetmeai",
  "provider": "qwen-chat",
  "model": "qwen3-vl-plus",
  "data": [
    { "url": "https://cdn.qwenlm.ai/.../image.png", "revised_prompt": "..." }
  ]
}
```

Supported `size` formats for Qwen Chat:

- `16:9`
- `9:16`
- `1:1`
- `4:3`
- You can also pass OpenAI-style `1024x1024`, `1792x1024`, `1024x1792` — they will be converted to aspect ratio.

Legacy DashScope mode is still available:

```json
{
  "provider": "dashscope",
  "model": "qwen-image-plus",
  "prompt": "..."
}
```

Details: [IMAGE_VIDEO_GENERATION_GUIDE.md](IMAGE_VIDEO_GENERATION_GUIDE.md) and [docs/IMAGE_GENERATION.md](docs/IMAGE_GENERATION.md)

## Video generation via Qwen Chat

Create videos and wait for results on the network:

```bash
curl http://localhost:3264/api/videos/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Camera slowly approaches futuristic city at night, cinematic, 5 seconds",
    "model": "qwen3-vl-plus",
    "size": "16:9",
    "wait": true
  }'
```

If you don't want to keep HTTP connection open:

```bash
curl http://localhost:3264/api/videos/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Robot walking in rain in neon city",
    "size": "16:9",
    "wait": false
  }'
```

Returns `task_id`. Check status:

```bash
curl http://localhost:3264/api/tasks/status/TASK_ID
```

Or wait for completion directly in status endpoint:

```bash
curl "http://localhost:3264/api/tasks/status/TASK_ID?wait=true"
```

## Open WebUI

For local Open WebUI:

```text
Base URL: http://localhost:3264/api
API Key: dummy-key
Model: qwen3.7-max
```

If Open WebUI is in Docker:

```text
Base URL: http://host.docker.internal:3264/api
API Key: dummy-key
```

Full instructions: [docs/OPENWEBUI_SETUP.md](docs/OPENWEBUI_SETUP.md)

## Hermes Agent / LiteLLM / Claude Code

Hermes custom provider:

```yaml
custom_providers:
  - name: qwen-free
    base_url: http://localhost:3264/api
    model: qwen3.7-max
    api_key: dummy-key
```

Ready example: [examples/hermes/config-snippet.yaml](examples/hermes/config-snippet.yaml)

For Hermes Agent the proxy supports OpenAI-compatible agent loop:

- `/api/chat/completions` and `/api/v1/chat/completions` accept `tools` / legacy `functions`;
- responses with tool calls return as `message.tool_calls` or streaming `delta.tool_calls` with `finish_reason: "tool_calls"`;
- tool-result continuations from Hermes (`role: "tool"`) don't break context: the proxy converts OpenAI transcript into full Qwen Chat prompt and continues answering after tool result;
- for Qwen Chat this adapts to web-chat behavior, so tool schemas are passed via system prompt, but the overall contract for Hermes stays OpenAI-compatible.

LiteLLM bridge for Claude Code:

```yaml
model_list:
  - model_name: qwen3.7-max
    litellm_params:
      model: openai/qwen3.7-max
      api_base: http://localhost:3264/api
      api_key: dummy-key
```

Ready example: [examples/litellm/qwen_litellm.yaml](examples/litellm/qwen_litellm.yaml)

## Docker

First add account locally, because inside the container there's no GUI for login:

```bash
npm run auth
```

Then:

```bash
docker compose up --build -d
```

In `docker-compose.yml` it's important to persist `session/`:

```yaml
services:
  qwen-proxy:
    build: .
    environment:
      - SKIP_ACCOUNT_MENU=true
      - PORT=3264
    ports:
      - "3264:3264"
    volumes:
      - ./session:/app/session
      - ./logs:/app/logs
      - ./uploads:/app/uploads
```

## Recommended models

- **General use / agents**: `qwen3.7-max`
- **Faster and lighter**: `qwen3.7-plus`
- **Coding**: `qwen3-coder-plus`
- **Images/videos via Qwen Chat**: `qwen3-vl-plus`
- **Open WebUI default**: `qwen3.7-max`

## Useful commands

```bash
npm run auth                  # account management
npm run models:sync           # update model list
npm run smoke                 # quick API check
SKIP_ACCOUNT_MENU=true npm start
```

Health checks:

```bash
curl http://localhost:3264/api/health
curl http://localhost:3264/api/status
curl http://localhost:3264/api/models
curl http://localhost:3264/api/images/status
curl http://localhost:3264/api/videos/status
```

## Documentation

- [docs/FORK_DEMO_QUICKSTART.md](docs/FORK_DEMO_QUICKSTART.md) — quick start for demos/videos.
- [docs/QWEN_CHAT_MODELS.md](docs/QWEN_CHAT_MODELS.md) — Qwen Chat model synchronization report.
- [IMAGE_VIDEO_GENERATION_GUIDE.md](IMAGE_VIDEO_GENERATION_GUIDE.md) — image and video generation via `chatType`.
- [docs/IMAGE_GENERATION.md](docs/IMAGE_GENERATION.md) — DashScope/Qwen Image endpoints.
- [docs/OPENWEBUI_SETUP.md](docs/OPENWEBUI_SETUP.md) — Open WebUI connection guide.
- [examples/hermes/config-snippet.yaml](examples/hermes/config-snippet.yaml) — Hermes Agent provider.
- [examples/litellm/qwen_litellm.yaml](examples/litellm/qwen_litellm.yaml) — LiteLLM bridge.

## Limitations

- This is unofficial browser-based proxy, Qwen may change external API.
- Qwen Chat accounts may hit rate limits; use multiple accounts for round-robin.
- Tokens expire — use `npm run auth -- --relogin`.
- Image/video generation depends on availability and Qwen Chat limits on specific account.
- Generated media URLs may be temporary.
- For production use carefully: this is a tool for experimenters, demos, and local workflows.
