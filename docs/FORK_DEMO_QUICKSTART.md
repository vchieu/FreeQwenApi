# Quick Start for Updated FreeQwenApi Fork Demo

> 🌐 **English** is the only documentation language.

This fork is prepared for a practical scenario for videos and demonstrations:

- synchronization of current Qwen Chat model list (`qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`);
- local OpenAI-compatible endpoint for SDK, Hermes Agent, Open WebUI and LiteLLM;
- quick smoke test to check if the proxy is alive before recording.

## 1. Authorize Once

```bash
npm install
npm run auth
```

Do not publish `session/`, cookies, and token files.

## 2. Synchronize Current Qwen Chat Models

```bash
npm run models:sync
```

The command reads public prerendered model metadata from `https://chat.qwen.ai/`, merges them with `src/AvailableModels.txt`, and writes the report here:

```text
docs/QWEN_CHAT_MODELS.md
```

## 3. Start the Endpoint

```bash
SKIP_ACCOUNT_MENU=true npm start
```

Endpoint:

```text
http://localhost:3264/api
```

## 4. Run Smoke Test

In another terminal:

```bash
npm run smoke
```

Default model for testing:

```text
qwen3.7-max
```

You can replace it:

```bash
QWEN_PROXY_SMOKE_MODEL=qwen3.7-plus npm run smoke
```

## 5. Test via OpenAI SDK / curl

```bash
curl http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "messages": [
      {"role": "user", "content": "Answer in one sentence: what is a local endpoint?"}
    ],
    "stream": false
  }'
```

## 6. Example Provider for Hermes Agent

```yaml
custom_providers:
  - name: qwen-free
    base_url: http://localhost:3264/api
    model: qwen3.7-max
    api_key: dummy-key
```

Running:

```bash
hermes chat --provider custom:qwen-free --model qwen3.7-max
```

## 7. Claude Code via LiteLLM Bridge

Claude Code expects Anthropic Messages API, but this proxy serves OpenAI Chat Completions. Use LiteLLM as a bridge:

```yaml
model_list:
  - model_name: qwen3.7-max
    litellm_params:
      model: openai/qwen3.7-max
      api_base: http://localhost:3264/api
      api_key: dummy-key

general_settings:
  master_key: ***
```

Start LiteLLM:

```bash
litellm --config qwen_litellm.yaml --host 127.0.0.1 --port 4000
```

Start Claude Code:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:4000"
export ANTHROPIC_AUTH_TOKEN="***"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model qwen3.7-max
```

## Important Clarification

You can say it like this:

> This is not a local model running on your GPU. This is a local OpenAI-compatible proxy to Qwen Chat — convenient for experimenting with AI agents and local tools.

Don't promise production stability: Qwen Chat limits, token lifetime, account status, and API compatibility may change.
