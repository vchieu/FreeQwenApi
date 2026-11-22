# AGENTS.md — project context for AI agents

## What this project is

FreeQwenApi is a **local OpenAI-compatible proxy to Qwen Chat**. It is *not* a local
GPU model and *not* the official DashScope/Qwen API. It drives a real, logged-in Qwen
Chat tab through Chrome DevTools Protocol (CDP) and exposes local endpoints (default
`http://localhost:3264/api`). English is the only documentation language.

## Quick start

```bash
npm install
npm run start:cdp
```

`start:cdp` opens (or reuses) a dedicated Chrome window with a persistent Qwen login
and starts the proxy non-interactively (`SKIP_ACCOUNT_MENU=1`, `NON_INTERACTIVE=1`,
`QWEN_CDP_URL=http://127.0.0.1:9222`). On the first run, log in to Qwen Chat in that
window, then retry. `src/env.js` autoloads `.env`, so `QWEN_CDP_URL` can be set there.

Other commands:

| Command | Purpose |
| --- | --- |
| `npm start` | Proxy without the CDP launcher (interactive account menu) |
| `npm run auth` | Add/list/relogin/remove Qwen accounts |
| `npm run models:sync` | Refresh `src/AvailableModels.txt` from Qwen |
| `npm run smoke` | API smoke test |
| `node scripts/core/verify-parser.mjs` | Offline check of the SSE answer parser |

## Layout

| Path | Role |
| --- | --- |
| `index.js` | Express entrypoint; routes under `/api`, imports `src/env.js` |
| `src/api/chat.js` | Chat completions: payload, headers, token, SSE parsing |
| `src/api/tokenManager.js` | Account/token state (`session/tokens.json`) |
| `src/browser/browser.js` | Puppeteer/CDP connection, fresh automation tab |
| `src/browser/auth.js` | Account login and token capture |
| `src/env.js` | `.env` autoload |
| `src/config.js`, `src/AvailableModels.txt` | Defaults and current model list |
| `src/dashboard/index.html` | Built-in status dashboard |
| `scripts/core/` | Runtime helpers that the proxy or operator actually uses |
| `scripts/inspect/` | One-off diagnostics/traces; safe to delete, not needed at runtime |
| `session/` | Gitignored live state: `baxia.json`, `tokens.json`, `ui-full-capture.json` |
| `examples/` | Node.js examples for OpenAI SDK, direct API, file upload, Hermes, LiteLLM |

Never commit `session/`, `.env`, `logs/`, or `.opencode/`.

## Critical rules for chat completions (learned the hard way)

1. **Use the CDP path.** Headless mode causes `Runtime.callFunctionOn` timeouts. The
   working setup is a real logged-in Chrome tab; avoid launching extra proxies or tabs.
2. **Token:** prefer the short-lived token from the Qwen tab (`localStorage.token`)
   via `readTokenFromQwenTab()`. `session/tokens.json` often holds a stale long-lived
   token and yields `401 Unauthorized`. On a 401, call `syncTokenFromPage()` +
   `markValid()` rather than switching to DashScope.
3. **WAF/Baxia:** `session/baxia.json` is required. Replay only the header set that
   `loadBaxiaHeaders()` uses. Strip the captured `x-request-id` and add **exactly one**
   fresh `crypto.randomUUID()` in `executeApiRequest()`; two request ids cause
   `Internal_Server_Error`, a stale one causes `FAIL_SYS_USER_VALIDATE`.
4. **Chat id binding:** Baxia `x5secdata` is bound to the captured `chat_id`. Send the
   body field `chat_id` exactly as captured — do **not** use `conversation_id` (the
   route hashes it to `chat_<hash>` and Qwen replies `CHAT_NOT_FOUND`). Refresh the
   capture with `scripts/core/capture-ui-full.mjs` followed by
   `scripts/core/sync-session-from-ui.mjs` after sending a real UI message.
5. **SSE parsing:** skip `thinking_summary` phases; only the final answer text becomes
   `choices[0].message.content`. Never hide an upstream error as empty `content` —
   surface it. A one-shot chat without explicit `chat_id` is deleted by
   `deleteChatV2()`, so its absence in the Qwen UI is expected.
6. **Captcha:** if a slider captcha (`nc_1_nocaptcha` / `_____tmd_____/report`) appears,
   stop all diagnostics immediately and ask the user; do not brute-force it.

## Verification checklist

```text
node --check index.js && node --check src/api/chat.js
node scripts/core/verify-parser.mjs            # -> PASS
npm run start:cdp                              # -> port 3264 starts listening
POST /api/chat/completions with the chat_id matching session/baxia.json
                                               # -> HTTP 200, non-empty content
```

Live request that worked:

```bash
curl -X POST http://127.0.0.1:3264/api/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.7-plus","chat_id":"<from session/baxia.json>","messages":[{"role":"user","content":"Say OK"}],"stream":false}'
```

## Style

- Keep changes minimal; do not change the working CDP request path without a reason.
- Diagnostics that are no longer needed belong in `scripts/inspect/`, not `scripts/core/`.
- `npm run test` is a placeholder; use the checks above instead.
