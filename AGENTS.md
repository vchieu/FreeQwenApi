# AGENTS.md — FreeQwenApi

Proxy Qwen Chat (chat.qwen.ai) → API tương thích OpenAI. Chạy qua **Chrome DevTools Protocol (CDP)**
điều khiển trực tiếp tab Chrome thật đã đăng nhập. Tự động inject CDP observer (`src/browser/sessionHook.js`)
bắt token và Baxia WAF headers từ traffic UI thật đẩy về `/api/session/sync`, không cần cài browser extension.
Cung cấp API OpenAI-compatible tại port mặc định 3264 (`http://localhost:3264/api` hoặc `/api/v1/*`).

**Single-account mode**: Proxy chỉ dùng 1 tài khoản Qwen từ tab Chrome đang mở. Token tự động refresh
mỗi ~15 phút qua observer. Không có multi-account rotation hay dashboard.

File này mô tả **cấu trúc, luồng hoạt động và trạng thái hiện tại của codebase**.
Dành cho AI agents đọc để nhanh chóng nắm bắt source code và tránh lặp lại các lỗi đã fix.

## Chạy & kiểm tra

```bash
npm install
npm run start:cdp                       # Khởi động Chrome CDP chuyên dụng + chạy proxy
```

`start:cdp` tự động mở (hoặc reuse) cửa sổ Chrome riêng với profile lưu session (`--remote-debugging-port=9222`,
`--user-data-dir=...`) và chạy proxy (`QWEN_CDP_URL=http://127.0.0.1:9222`). Lần đầu chạy cần đăng nhập tài khoản Qwen trên cửa sổ Chrome vừa mở.

Các lệnh tiện ích khác:

| Lệnh | Mục đích |
| --- | --- |
| `npm start` | Chạy proxy thông thường (single-account mode) |
| `npm run models:sync` | Đồng bộ danh sách model từ Qwen về `src/AvailableModels.txt` |
| `npm run smoke` | Chạy smoke test API (`scripts/inspect/smoke_test.js`) |

Kiểm tra cú pháp & kiểm tra offline (không cần browser, không cần network):

```bash
# Cú pháp (Windows CMD)
node --check index.js && node --check src/api/chat.js && node --check src/api/routes.js && node --check src/api/resilience.js && node --check src/utils/notify.js && node --check src/api/fileUpload.js && node --check src/api/reasoning.js && node --check src/api/toolCalls.js && node --check src/api/authRecovery.js && node --check src/api/quotaLimit.js && node --check src/api/upstreamErrors.js && node --check src/api/sessionSync.js

# Hoặc PowerShell
node --check index.js; node --check src/api/chat.js; node --check src/api/routes.js; node --check src/api/resilience.js; node --check src/utils/notify.js; node --check src/api/fileUpload.js; node --check src/api/reasoning.js; node --check src/api/toolCalls.js; node --check src/api/authRecovery.js; node --check src/api/quotaLimit.js; node --check src/api/upstreamErrors.js; node --check src/api/sessionSync.js

# Chạy bộ verify offline
node scripts/core/verify-parser.mjs            # Kiểm tra parser SSE câu trả lời
node scripts/core/verify-reasoning.mjs         # Kiểm tra mapping reasoning_effort & thinking stream
node scripts/core/verify-tools.mjs             # Kiểm tra parser tool_calls, format prompt, recovery JSON, text tool call
node scripts/core/verify-auth-retry.mjs        # Kiểm tra nhận diện 401, chọn token xoay, chọn tab proxy-owned
node scripts/core/verify-images.mjs            # Kiểm tra tách/chỉ upload ảnh lượt hiện tại
node scripts/core/verify-resilience.mjs        # Kiểm tra retry network error, phát hiện captcha, lệnh notification
node scripts/core/verify-quota.mjs             # Kiểm tra nhận diện quota limit (extra.update_member: true, fallback ≥2 pattern)
node scripts/core/verify-audit-fixes.mjs     # Kiểm tra phân loại lỗi upstream (Node + mirror browser), 429 cooldown, nested JSON error
```

Kiểm tra trực tiếp endpoint khi proxy đang chạy:
```bash
# Kiểm tra session đã sync
curl -s http://127.0.0.1:3264/api/session/sync

# Gửi chat test (không cần truyền chat_id, proxy tự xử lý)
curl -X POST http://127.0.0.1:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.7-plus","messages":[{"role":"user","content":"Say OK"}],"stream":false}'
```

## Đọc file nào khi nào

| File | Vai trò | Đọc khi cần |
| --- | --- | --- |
| `index.js` | Express server entrypoint; nạp `src/env.js`, mount `/api`, graceful shutdown | Khởi động server, cấu hình CORS, middleware parse JSON, port bind |
| `src/api/routes.js` | Toàn bộ router HTTP: `/chat/completions`, `/v1/chat/completions`, `/models`, images, videos, tasks | Xử lý request, resolve chat_id/parent_id, map model, stream SSE, route API |
| `src/api/chat.js` | Giao tiếp core với Qwen: build payload, header Baxia, `sendMessage()`, `executeApiRequest()`, page pool, delete chat | Lỗi kết nối Qwen, request header WAF, gọi browser evaluate, vòng đời chat |
| `src/api/toolCalls.js` | Pure module: `messagesToQwenPrompt()` (chèn `# Tool Use`), `parseToolCalls()` (fence/XML + JSON trần/prose/nhiều call), lenient JSON parser | Sửa cách gọi tool, định dạng tool_call fences, recovery lỗi JSON arguments |
| `src/api/authRecovery.js` | Pure module: nhận diện 401, chọn token xoay hợp lệ, chọn tab proxy-owned để reload | Sửa luồng retry 401, chờ/xoay token |
| `src/api/resilience.js` | Pure module: phân loại lỗi mạng có thể retry, nhận diện tín hiệu captcha (WAF `_____tmd_____`, slider `nc_1_nocaptcha`, title `Verification`), text thông báo | Sửa retry network error, phát hiện/handle captcha |
| `src/utils/notify.js` | Fire-and-forget desktop alert (Windows MessageBox, macOS `osascript`, Linux `notify-send`); `notificationCommand()` pure để test | Sửa cách notify user khi cần giải captcha |
| `src/api/reasoning.js` | Pure module: map `reasoning_effort` → Qwen `feature_config`, accumulator stream thinking | Chỉnh chế độ suy nghĩ (Fast/Auto/Thinking), xử lý stream suy nghĩ |
| `src/api/sessionSync.js` | Nhận & validate token/Baxia headers từ CDP observer; ghi file atomic `baxia.json`, lưu token vào `auth_token.txt` | Cập nhật WAF headers, logic lọc header, lưu trữ token tự động |
| `src/api/quotaLimit.js` | Pure module: nhận diện quota limit (`extra.update_member: true`, fallback ≥2 pattern), tạo thông báo lỗi | Xử lý khi account hit daily quota |
| `src/api/upstreamErrors.js` | Pure module: phân loại lỗi SSE/JSON upstream (RateLimited→429, structured→500, quota→429 `quotaLimited`), message cooldown 429 từ `num` | Sửa phân loại lỗi stream/non-stream, thông báo 429 |
| `src/api/modelMapping.js` | Chuẩn hoá tên model, resolve alias/custom model về canonical Qwen model | Thêm alias model, map model từ client bên thứ ba |
| `src/api/fileUpload.js` | Upload file lên OSS của Qwen qua STS token; `collectImageParts()` / `prepareOpenAIImages()` chuyển ảnh OpenAI thành `messages[].files` | Upload file đính kèm, tài liệu, hình ảnh, xử lý ảnh OpenAI `image_url` |
| `src/api/imageGeneration.js` | Sinh ảnh qua Qwen Chat (`chatType: t2i`) hoặc DashScope | Sửa prompt sinh ảnh, đổi tỷ lệ khung hình |
| `src/api/chatHistory.js` | Lưu/đọc lịch sử hội thoại cục bộ theo chatId trong `session/history/` | Debug lịch sử, đồng bộ context hội thoại |
| `src/browser/browser.js` | Khởi tạo Puppeteer / kết nối CDP (`QWEN_CDP_URL`), quản lý browser context | Cấu hình CDP, viewport, User-Agent, stealth flags |
| `src/browser/sessionHook.js` | Observer tự động inject vào tab Qwen: hook `fetch`/`XHR`, đẩy token & Baxia về proxy | Theo dõi lưu lượng mạng trình duyệt, auto-sync session |
| `src/browser/auth.js` | Kiểm tra đăng nhập, luồng đăng nhập thủ công, xử lý captcha phát hiện | Xử lý login, xác thực session |
| `src/config.js` | Điểm tập trung đọc biến môi trường và fallback default constants | Xem default timeout, kích thước pool, port, URL endpoints |
| `src/env.js` | Autoload file `.env` trước khi khởi chạy các module khác | Nạp biến môi trường |
| `scripts/core/start-cdp.mjs` | Script launcher mở Chrome có CDP port 9222 và chạy proxy | Chỉnh tham số khởi động Chrome, profile dir |
| `scripts/core/verify-*.mjs` | Bộ 8 script test offline (parser, reasoning, tools, images, auth-retry, resilience, quota, audit-fixes) | Kiểm tra regression logic cốt lõi mà không cần mở trình duyệt |
| `session/` | Thư mục runtime gitignored (`baxia.json`, `auth_token.txt`, `history/`) | Xem trạng thái token, header WAF thực tế |

### Luồng xử lý chat completion
`POST /api/chat/completions` (hoặc `/v1/chat/completions`):
1. **Tool Check & Prompt Folding**: Nếu request có `tools`/`functions`, gọi `messagesToQwenPrompt()` gộp toàn bộ lịch sử hội thoại + schema tool thành 1 prompt duy nhất có định dạng `# Tool Use` và hướng dẫn output block ` ```tool_call `. (Qwen Web API không hỗ trợ OpenAI tool schema trực tiếp).
2. **Model Resolution**: `resolveRequestedModel()` ánh xạ tên model được yêu cầu về canonical model của Qwen.
3. **Reasoning Mode**: `reasoningOptionsFromEffort()` chuyển đổi `reasoning_effort` (`low/none/minimal` → `Fast`, `medium` → `Auto`, `high/xhigh/max` → `Thinking`), ghi đè `feature_config`.
4. **Chat & Parent ID Resolution**: Tìm `chat_id` / `conversation_id` từ body/header hoặc tính `chat_<hash>` theo nội dung tin nhắn đầu tiên.
5. **Gửi Request**: `sendMessage()` → `executeApiRequest()` trong ngữ cảnh browser tab:
   - Đọc token mới nhất từ tab (`localStorage.token`).
   - Nạp headers từ `session/baxia.json`.
   - Bỏ `x-request-id` cũ và sinh **đúng 1 UUID mới**.
6. **Xử lý SSE Stream / Kết quả**:
   - `consumeThinkingDelta()`: gom delta `reasoning_content` (stream riêng, không lẫn vào `content`).
   - Nếu có tools: `resolveToolCalls()` bóc tách các block fence ` ```tool_call ` hoặc XML, giữ lại phần prose (nếu có) trong `content`, trả về `finish_reason: "tool_calls"`.
7. **Dọn dẹp**: `cleanupEphemeralChat()` gọi `deleteChatV2()` xoá chat tạm trên Qwen theo cấu hình `AUTO_DELETE_CHATS` (mặc định là bật).

## Config chính

Tất cả cấu hình được định nghĩa tại `src/config.js`, nạp từ `.env`:

- **Mạng & Server**:
  - `PORT`: Port Express server (mặc định: `3264`).
  - `HOST`: Host bind (mặc định: `0.0.0.0`).
  - `QWEN_BASE_URL`: Mặc định `https://chat.qwen.ai`.
- **Browser & CDP**:
  - `QWEN_CDP_URL`: URL CDP Chrome (ví dụ: `http://127.0.0.1:9222`). Khuyên dùng chế độ này.
  - `PUPPETEER_PROTOCOL_TIMEOUT_MS`: Timeout giao thức Puppeteer (mặc định: `300000` ms).
  - `PAGE_POOL_SIZE`: Số tab giữ trong pool khi không dùng CDP trực tiếp (mặc định: `3`).
  - `VIEWPORT_WIDTH` / `VIEWPORT_HEIGHT`: 1920x1080.
- **Timeouts**:
  - `PAGE_TIMEOUT`: 120,000 ms.
  - `AUTH_TIMEOUT`: 120,000 ms.
  - `NAVIGATION_TIMEOUT`: 60,000 ms.
  - `RETRY_DELAY`: 2,000 ms.
  - `STREAMING_CHUNK_DELAY`: 20 ms.
  - `NODE_STREAM_TIMEOUT_MS`: 180,000 ms (3 phút) — `AbortSignal.timeout` cho `fetch` Node. Khi stall thì đánh dấu `nodeTimeout` và retry trên chat mới, không treo client.
  - `TASK_POLL_INTERVAL`: 2,000 ms; `TASK_POLL_MAX_ATTEMPTS`: 90.
  - `CAPTCHA_POLL_INTERVAL_MS`: 1,000 ms — chu kỳ poll trạng thái tab Qwen để phát hiện captcha.
  - `CAPTCHA_WAIT_TIMEOUT_MS`: 300,000 ms (5 phút) — tối đa chờ user kéo slider trước khi trả lỗi cho client.
  - `QWEN_CAPTCHA_NOTIFY`: đặt `off` để tắt desktop notification (mặc định bật).
- **Dọn dẹp hội thoại Qwen (`AUTO_DELETE_CHATS`)**:
  - `AUTO_DELETE_CHATS` (`all` / `true` / `1`): Xoá các chat do proxy tạo ra trên Qwen sau khi trả lời xong.
  - `failed`: Chỉ xoá chat khi gặp lỗi.
  - `off`: Không xoá (tiện khi cần xem chat trong giao diện web Qwen).
- **Thư mục lưu trữ**:
  - `SESSION_DIR`: Mặc định `session`.
  - `LOGS_DIR`: Mặc định `logs`.
  - `UPLOADS_DIR`: Mặc định `uploads`.

## Hành vi hiện tại cần lưu ý

### 1. Cơ chế CDP & Chrome Tab
- Chế độ khuyến nghị duy nhất là CDP (`npm run start:cdp` hoặc biến `QWEN_CDP_URL`).
- Chạy headless hoàn toàn sẽ gây ra timeout `Runtime.callFunctionOn` hoặc bị WAF chặn.
- Trình duyệt chạy với user-data-dir riêng biệt tại `%TEMP%/freeqwenapi-chrome-cdp` để lưu session đăng nhập.

### 2. CDP Observer & Session Sync tự động
- Module `src/browser/sessionHook.js` được proxy tự động inject vào mọi tab Qwen mở ra (`evaluateOnNewDocument`).
- Hook cả `window.fetch` và `XMLHttpRequest.prototype` để quan sát request `/api/v2/chat/completions`.
- Bắt token và cặp WAF headers (`bx-umidtoken`, `bx-ua`), sau đó gửi POST tới `/api/session/sync` của proxy.
- `src/api/sessionSync.js` xác thực JWT, kiểm tra headers, và ghi nguyên tử (`writeJsonAtomic`) vào `session/baxia.json` và lưu token vào `session/auth_token.txt`. Không cần can thiệp thủ công hay extension.

### 3. Token Management (Single Account)
- Qwen sử dụng token ngắn hạn trong trình duyệt (`localStorage.getItem('token')`), sống ~15 phút.
- Proxy chỉ dùng **1 tài khoản duy nhất** từ tab Chrome đang mở. Token được observer tự động sync về `session/auth_token.txt`.
- Hàm `readTokenFromQwenTab()` đọc token sống trực tiếp từ tab Chrome. Nếu token sắp hết hạn (<30s), tự động chờ xoay tự nhiên hoặc force reload tab proxy-owned để ép SPA cấp token mới.
- Khi gặp lỗi `401 Unauthorized`: `recoverBrowserToken()` reload **tab do proxy sở hữu** (`pickProxyOwnedQwenPage()`, không đụng tab người dùng) sau khi xoá `token` trong `localStorage` để ép SPA cấp token mới, rồi retry (tối đa `MAX_RETRY_COUNT`). Dùng chung cho 401 lúc tạo chat và lúc gửi message.
- **Không có multi-account rotation hay dashboard**. Token tự động refresh mỗi ~15 phút qua observer.

### 4. WAF / Baxia & Request ID
- Replay chính xác header set mà `loadBaxiaHeaders()` chuẩn bị từ `session/baxia.json`.
- **Quan trọng**: `x5secdata` của Baxia bị ràng buộc chặt chẽ với `chat_id` đã capture.
- Luôn loại bỏ `x-request-id` cũ và sinh **duy nhất một** UUID mới bằng `crypto.randomUUID()` trong `executeApiRequest()`. Nếu gửi 2 header request id sẽ bị `Internal_Server_Error`, nếu dùng request id cũ sẽ bị `FAIL_SYS_USER_VALIDATE`.

### 5. Xử lý Reasoning & Thinking Stream
- Hệ thống hỗ trợ tách bạch hoàn toàn giữa suy nghĩ (`reasoning_content`) và nội dung trả lời (`content`).
- Ánh xạ `reasoning_effort` → `feature_config`:
  - `low` / `none` / `minimal`: `thinking_enabled: false`, `auto_thinking: false`, `thinking_mode: "Fast"`, xoá `thinking_format`.
  - `medium`: `thinking_enabled: true`, `auto_thinking: true`, `thinking_mode: "Auto"`, `thinking_format: "summary"`.
  - `high` / `xhigh` / `max`: `thinking_enabled: true`, `auto_thinking: false`, `thinking_mode: "Thinking"`, `thinking_format: "summary"`.
  - Không truyền `reasoning_effort`: Giữ nguyên mặc định của Qwen (Auto).
- Trong stream SSE: chunk reasoning được stream trước (`delta.reasoning_content`), sau đó đến lượt answer chunk (`delta.content`). Tuyệt đối không để rò rỉ suy nghĩ vào trường `content`.

### 6. Tool Calling Protocol
- Porting từ giải pháp của `qwen-web2api/tools.py`:
  - Khi client gửi `tools`, hàm `messagesToQwenPrompt()` ép phẳng mảng `messages` thành 1 prompt hoàn chỉnh kèm định nghĩa công cụ trong block `# Tool Use`.
  - Model phản hồi công cụ dưới dạng fence:
    ````text
    ```tool_call
    {"name": "read_file", "arguments": {"path": "index.js"}}
    ```
    ````
    hoặc thẻ XML `<tool_call><function=...><parameter=...>...</parameter></function></tool_call>`.
- `parseToolCalls()` chỉ thực thi JSON trần khi **toàn bộ message** (sau trim) chỉ gồm JSON tool-call (1 hoặc nhiều object liên tiếp, không có prose); trường hợp `prose\n{json}` ở cuối message không thực thi mà ghi `bare-json-after-prose` để kích hoạt soft nudge, còn `prose + JSON` giữa câu hay JSON thường không có shape tool vẫn giữ nguyên là text; fence bị từ chối do có prose cùng dòng vẫn là text và ghi drop để nudge mềm.
- Parser chịu lỗi (lenient JSON repair: tự động sửa lỗi thiếu arguments key dạng `{"name":"foo",{"path":"x"}}`, sửa trailing commas, single quotes).
- Lọc bỏ các tool không khai báo (ví dụ `code_interpreter` tích hợp của Qwen) hoặc thiếu param bắt buộc.
- Phần chữ giải thích (prose) đi cùng tool call được bảo toàn trong `content`, các block fence/JSON đã parse được tách sạch sẽ.
- `sendMessage()` gom hậu xử lý tool call thành `finalizeToolCallsInResponse()` gọi lại sau cả nudge retry: response thứ hai cũng luôn có `tool_calls_normalized`, `tool_calls_clean_text`, không để tool call sót lại thành text. `routes.js` giữ prose đó thay vì ép `content` về `''`.

### 7. Network retry & Captcha notification
- `fetch` trong tab Qwen đôi khi chết giữa chừng (`TypeError: network error`, `socket hang up`, `fetch failed`) do WAF reset hoặc tab chuyển hướng. `src/api/resilience.js` phân loại đây là lỗi mạng tạm thời: `handleApiError()` chờ `RETRY_DELAY` rồi retry **cùng chat** (giữ nguyên `tools`/`systemMessage`), tối đa `MAX_RETRY_COUNT`. HTTP 4xx/5xx và response đã stream một phần (`hasStreamedChunks`) **không** retry để tránh nhân đôi content.
- Captcha được nhận diện sớm cả trước lẫn trong lúc request (`readCaptchaSignal()` + `startCaptchaWatcher()`): URL `_____tmd_____`, marker slider `nc_1_nocaptcha`/`baxia-dialog`, hoặc title `Verification`. Khi phát hiện: bắn desktop notification ngay (`src/utils/notify.js`: MessageBox trên Windows, `osascript` trên macOS, `notify-send` trên Linux) và gửi **chunk SSE ngoài băng** cho client (kể cả route có `tools` qua `onCaptcha`). Tuyệt đối không ghi notice vào `delta.content`: client OpenAI nối field này thành câu trả lời, làm captcha/error dính liền vào text của model. `routes.js` dùng `writeProxyNotice()` → chunk có `choices[0].delta = {}` + field `proxy_notice: {kind, message}`. Captcha chỉ dùng notice này (request sẽ tiếp tục và trả lời sau). Lỗi terminal dùng `writeProxyError()`: vẫn có `proxy_notice`, thêm SSE `error: {message,type}` và — **chỉ khi chưa stream content thật** — một dòng `⚠️ Error: ...` vào `delta.content` để client vẫn thấy lỗi; không bao giờ chèn vào answer đã stream một phần.
- Proxy tiếp tục poll tab (`CAPTCHA_POLL_INTERVAL_MS`) tối đa `CAPTCHA_WAIT_TIMEOUT_MS`; sau khi user kéo slider xong tự động retry (trên chat mới, xem bên dưới). Nếu hết timeout trả `{error, verification:true, captcha:true}` để client biết thay vì im lặng đến lúc `PAGE_TIMEOUT`. Không bao giờ tự solve captcha bằng code.
- **Chỉ xét frame visible**: Qwen giữ lại iframe 0x0 `baxia-dialog-content` (`_____tmd_____/punish`) sau khi đã giải captcha. `readCaptchaSignal()` dùng `frame.frameElement().boundingBox()` (`isVisibleBox()`) để bỏ frame ẩn; nếu quét URL mọi frame thì `waitForCaptchaClear()` sẽ chạy đúng 300s rồi trả lỗi dù user đã kéo slider xong.
- **Sau captcha phải retry chat MỚI**: fetch trong tab chết khi WAF chặn nhưng phía Qwen vẫn đang generate. Gửi lại vào cùng `chat_id` bị `500 {"data":{"code":"CHAT_IN_PROGRESS","details":"The chat is in progress!"}}`. `handleApiError()` nhận diện `isChatInProgress()`, xoá chat cũ rồi retry với `chatId=null/parentId=null` (history vẫn nằm trong `messages`). Đường captcha-recovery cũng làm vậy luôn, không đợi dò lỗi.
- **Protocol timeout (`Runtime.callFunctionOn timed out`) là lỗi retryable**: `isProtocolTimeoutError()` (pure) nhận diện `Runtime.callFunctionOn/evaluate timed out`, `ProtocolError`, `Target closed`. Vì fetch trong tab có thể vẫn đang generate sau khi Puppeteer huỷ CDP call, `handleApiError()` xoá chat cũ rồi retry trên **chat mới** có giới hạn (`MAX_RETRY_COUNT`); catch của `sendMessage()`/`createChatV2()` cũng đi đường này thay vì trả chuỗi `Error: ProtocolError...` thô cho client. Không phải tăng `PUPPETEER_PROTOCOL_TIMEOUT_MS`.
- **Node fetch stall cũng retry chat mới**: `executeApiRequestWithNodeStreaming()` dùng `AbortSignal.timeout(NODE_STREAM_TIMEOUT_MS)`. TimeoutError được gắn cờ `nodeTimeout` (`isNodeStreamTimeout()` pure) rồi đi chung đường fresh-chat retry với protocol timeout; không để request treo vô hạn như trước (đã thấy 6.5 phút không có response). Test regression: `verify-resilience.mjs`.
- **Route có `tools` vẫn stream qua Node**: `routes.js` truyền `collectOnly: captureToolCalls` → `sendMessage()` dùng sink nội bộ (`onChunk = () => {}`) và **giữ nguyên callback final-answer của route**. Nhờ vậy `executeApiRequest()` đi `executeApiRequestWithNodeStreaming()` thay vì ôm toàn bộ SSE trong 1 `page.evaluate()` dài (đây là nguyên nhân protocol timeout). `onReasoning` vẫn stream live ở **lần thử đầu** ngay cả khi `collectOnly: true`, và chỉ bị tắt ở lần nudge retry (`_toolRetryDone`) hoặc khi retry sau `hasStreamedReasoning` để tránh lặp thinking (`routes.js` cũng truyền `skipReasoning: hasStreamedReasoning` vào `writeToolCallsSse`). Test regression: `verify-resilience.mjs`, `verify-tools.mjs`.

### 8. Media & Async Tasks
- Hỗ trợ Text-to-Image (`/api/images/generations`) qua Qwen Chat (`chatType: t2i`) và DashScope fallback.
- Hỗ trợ Text-to-Video (`/api/videos/generations`) qua Qwen Chat (`chatType: t2v`).
- Polling trạng thái tác vụ qua `/api/tasks/status/:taskId`.
- Ảnh đầu vào OpenAI (`image_url` dạng data URL hoặc http URL) trong `/api/chat/completions` và `/api/v1/chat/completions` được tải lên OSS Qwen rồi đưa vào `messages[].files` theo đúng shape UI; nội dung `content` chỉ giữ phần text.

## Điểm dễ vỡ (Learned the hard way)

1. **Ràng buộc Baxia x5secdata**: `x5secdata` trong `session/baxia.json` bị gắn với `chat_id`. Hãy để observer tự động cập nhật hoặc dùng capture hợp lệ.
2. **x-request-id trùng lặp hoặc cũ**: Bắt buộc strip `x-request-id` có sẵn và chỉ chèn 1 UUID duy nhất. 2 ID gây lỗi 500, ID cũ gây lỗi 403 `FAIL_SYS_USER_VALIDATE`.
3. **Headless Timeout**: Không chạy Chrome headless tự tạo mà không có flag stealth/profile thật. Luôn ưu tiên đường CDP nối vào Chrome thật (`start:cdp`).
4. **Token hết hạn**: Token trong `localStorage` của tab Qwen là nguồn chuẩn. Observer tự động sync về `session/auth_token.txt`.
5. **Slider Captcha (`nc_1_nocaptcha`)**: Nếu xuất hiện slider captcha hoặc trang chuyển hướng về `_____tmd_____/report`, **dừng tự động ngay lập tức** (không cố giải bằng code), bắn desktop notification + SSE notice cho client, rồi chờ user kéo captcha và retry cùng chat. Không restart browser như cũ (việc đó làm mất tab user đang thao tác). Test regression: `verify-resilience.mjs`.
6. **Chat biến mất trên web Qwen**: Khi `AUTO_DELETE_CHATS=all` (mặc định), proxy tự động gọi `deleteChatV2()` để dọn dẹp các chat tạm sinh ra. Đây là hành vi bình thường, không phải lỗi.
7. **OpenWebUI Meta Request**: Các request kiểm tra tiêu đề/tags từ Open WebUI (`isOpenWebUiMetaRequest`) được tách ra xử lý riêng để không làm hỏng context hội thoại chính.
8. **401 khi tạo chat cũng có dạng HTTP 200**: `createChatV2()` có thể nhận `200` với body `{success:false, data:{code:"unauthorized", details:"401 Unauthorized"}}`. Phải coi như 401, dùng `recoverBrowserToken()` (chờ xoay ngắn → reload tab proxy-owned để ép token mới, loại trừ token vừa bị từ chối) rồi retry tối đa `MAX_RETRY_COUNT`; không trả lỗi ngay cho client. Token dùng cho retry cũng phải được giữ nguyên khi gửi message. Test regression: `verify-auth-retry.mjs`.
9. **STS upload đã chuyển sang `/api/v2/files/getstsToken`**: URL v1 trả `405`. Response có dạng `{success:true, request_id, data:{...}}` — `getStsToken()` phải unwrap lấy `data` thì `uploadFile()` mới thấy `file_path`/`file_id`. Ảnh sau khi upload phải nằm ở `messages[].files` (type `image`, `file_class: vision`, `url` là signed OSS URL), không được nhét vào `content`.
10. **`messages[].content` của Qwen Web phải là string**: Sau khi tách các part `image_url` ra khỏi content của OpenAI, nếu còn lại mảng part (`[{type:'text',...}]`) thì Qwen trả `internal_error` ngay. `prepareOpenAIImages()` phải gom các part text còn lại thành một string trước khi gọi `sendMessage()`.
11. **Chỉ upload ảnh của lượt hiện tại**: Client OpenAI (OpenWebUI...) gửi lại toàn bộ history, trong đó có cả ảnh của các lượt trước. `collectImageParts()` chỉ chọn ảnh trong user message cuối; ảnh cũ được thay bằng placeholder `[image]` và không upload lại, nếu không mỗi request sẽ đính lại toàn bộ ảnh cũ vào chat Qwen. Test regression: `verify-images.mjs`.
12. **Tool call trần và nudge retry**: Qwen đôi khi trả JSON tool call không có fence: chỉ khi **toàn bộ message** là JSON tool call mới tự động thực thi; trường hợp `prose\n{json}` ở cuối message tạo `bare-json-after-prose` → soft nudge trung lập (không thực thi mù). Fence có prose cùng dòng là mô tả/ví dụ, giữ nguyên và soft nudge. `finalizeToolCallsInResponse()` phải chạy lại sau nudge retry (`_toolRetryDone`) nếu không tool call sẽ sót lại thành text như đã thấy với `todowrite`. Test regression: `verify-tools.mjs`.
13. **`TypeError: network error` không được trả thẳng cho client**: Đây là `fetch` trong tab bị WAF/reset chặng giữa SSE. `handleApiError()` phải retry cùng chat (tối đa `MAX_RETRY_COUNT`). Đường node-streaming phải gắn `hasStreamedChunks` ngay trong `catch`, nếu không response sẽ bị coi là chưa stream và fallback sang browser → gửi lại cả nội dung cũ. Test regression: `verify-resilience.mjs`.
14. **Captcha mà user không để ý thì request đứng timeout**: `checkVerification()` cũ chỉ đọc title và `promptUser()` trên stdin (hang ở `NON_INTERACTIVE`). Giờ dùng `readCaptchaSignal()` + watcher poll tab; SSE notice + desktop alert được bắn ngay, client thấy thông báo thay vì đợi `PAGE_TIMEOUT`. `routes.js` phải truyền `onCaptcha` ngay cả khi route có `tools` (lúc đó `streamingCallback` bị tắt). Test regression: `verify-resilience.mjs`.
15. **Popup Windows biến mất khi spawn notification**: `spawn('powershell.exe', ..., {detached:true})` và cờ `-NonInteractive` làm `MessageBox::Show()` trả về ngay **không hiện UI**. Phải spawnAttached (`detached` mặc định `false`) rồi `child.unref()`; giữ `windowsHide:false`. Ngoài ra slider captcha nằm trong iframe và marker là id/class (`nc_1_nocaptcha`), không phải `innerText` — `readCaptchaSignal()` phải quét `page.frames()` + thuộc tính phần tử visible.
16. **Client đứng sau khi user đã kéo slider xong**: Qwen không xoá iframe 0x0 `baxia-dialog-content` (`_____tmd_____/punish`) sau khi solve. Nếu `readCaptchaSignal()` quét URL **mọi** frame, `waitForCaptchaClear()` thấy captcha liên tục và chỉ thoát sau 300s rồi trả lỗi — client tưởng proxy treo. Phải lọc frame bằng `frame.frameElement().boundingBox()`/`isVisibleBox()` trước khi check URL lẫn HTML. Test regression: `verify-resilience.mjs`.
17. **`CHAT_IN_PROGRESS` sau captcha**: fetch chết ở browser nhưng Qwen vẫn generate; retry cùng `chat_id` nhận `500 {"data":{"code":"CHAT_IN_PROGRESS","details":"The chat is in progress!"}}`. `isChatInProgress()` (pure) + `handleApiError()` phải xoá chat cũ rồi retry với `chatId=null/parentId=null` thay vì trả lỗi cho client. Log cũ ghi `Error getting response: undefined` vì chỉ đọc `response.error`; giờ ưu tiên `errorBody`. Test regression: `verify-resilience.mjs`.
18. **Route có `tools` treo đúng 5 phút rồi `ProtocolError`**: `PUPPETEER_PROTOCOL_TIMEOUT_MS=300000` cắt mọi `page.evaluate()` chạy quá 300s. Tool route cũ set `streamingCallback=null` nên ôm toàn bộ SSE trong 1 evaluate duy nhất → timeout. Giờ dùng cờ `collectOnly` để vẫn stream qua Node (sink nội bộ), route tự ghi chunk cuối/tool call. `isProtocolTimeoutError()` + retry chat mới xử lý các timeout còn sót (kể cả lúc tạo chat); **không** giải bằng cách tăng timeout. `pagePool.getPage()`/`isHealthyQwenPage()` cũng bọc `withTimeout` (15s/5s) để bỏ tab treo nhanh. Test regression: `verify-resilience.mjs`.
19. **Node-streaming bị WAF chặn nếu thiếu Cookie/Origin/Referer**: `loadBaxiaHeaders()` cố tình bỏ cookie (browser tự gửi). Fetch từ Node không có cookie jar → Qwen trả `200 text/html` (`Unexpected non-SSE 200`) dù đã có Baxia headers + UA. Phải copy cookie Qwen từ tab (`qwenCookieHeader()` qua CDP `Network.getAllCookies`, lọc domain `qwen.ai`) rồi gửi kèm `Origin`/`Referer` = origin của `CHAT_API_URL`. Khi đó SSE chạy bình thường; giữ fallback browser nếu vẫn bị chặn. Test regression: `verify-resilience.mjs` + test live request có `tools`.
20. **Proxy notice/error lọt vào `delta.content`**: OpenCode (và mọi client OpenAI) nối toàn bộ `delta.content` thành câu trả lời; captcha notice / `Error: ...` từng dính liền vào text thật của model trong session `ses_df45b870...`. Mọi thông điệp điều khiển phải đi chunk riêng (`proxy_notice`, `delta: {}`) qua `writeProxyNotice()`, không được ghi vào content. Ngoại lệ có chủ đích: lỗi terminal đi qua `writeProxyError()` — `proxy_notice` + `error` object + (chỉ khi chưa có answer) dòng `⚠️ Error: ...` để client thấy lỗi. `hasStreamedChunks` phải khai báo **ngoài `try`** trong `executeApiRequestWithNodeStreaming()`; nếu nằm trong `try`, catch early-fetch sẽ ném `ReferenceError`, nhảy qua `handleApiError()` → không retry và client thấy assistant rỗng. Node fetch cũng cần `AbortSignal.timeout(NODE_STREAM_TIMEOUT_MS)` — nếu không, connection stall treo vô hạn (đã thấy 6.5 phút) và client phải bấm continue/đổi model. Test regression: `verify-resilience.mjs` (28 checks).

21. **429 chỉ được nhận diện từ `code==="RateLimited"`**: Chunk SSE có `code && detail` không tự động là rate limit — `FAIL_SYS_USER_VALIDATE` hay bất kỳ lỗi có cấu trúc nào khác phải đi đường lỗi thông thường (500), không phải 429. Chỉ `chunk.code === 'RateLimited'` mới set `status=429`. Test regression: `verify-audit-fixes.mjs`.
22. **Ảnh cũ bị 404 không được phá session**: Khi `includeHistory: true`, `prepareOpenAIImages()` upload cả ảnh của các lượt trước. Nếu URL cũ trả 404, chỉ ghi placeholder `[image upload failed]` vào `content` lịch sử; **không** trả error 400 cho cả request. Lỗi upload chỉ dừng request khi ảnh của lượt **hiện tại** thất bại và không có file nào upload được (`currentTurnHadAttachments && !files.length && currentTurnErrors.length`). Test regression: `verify-audit-fixes.mjs`.
23. **`file://`, `file:/` và URL không phải http/data bị từ chối ngay**: `attachmentSourceToBuffer()` kiểm tra regex `^[a-z][a-z0-9+-.]*:/` (bắt cả `://` và `:/`) trước khi fallback raw base64, ngăn `file:///home/user/image.png` và `file:/path/img` bị decode như base64 (tạo ra dữ liệu rác). Test regression: `verify-audit-fixes.mjs`.
24. **JSON trần sau prose KHÔNG được tự động thực thi, nhưng tạo soft nudge (finding #1)**: `prose
{tool_call_json}` là dạng nguy hiểm vì model có thể đang trích dẫn ví dụ hoặc cảnh báo. `collectWholeMessageBareToolCalls()` trả sentinel `BARE_JSON_AT_END`; `parseToolCalls()` ghi `bare-json-after-prose` vào `dropped`; `shouldRetryToolCall()` trả **`'soft'`** cho drop này — nudge trung lập, không thực thi. Chỉ toàn bộ message là JSON (không có prose) mới được nhận. Test regression: `verify-tools.mjs` (nhóm "R1/R7 regression fixes").
25. **Structured error non-RateLimited trong stream phải surface ngay là 500 (R3b)**: `chunk.code && !chunk.choices` (ví dụ `ContentFiltered`, `FAIL_SYS_USER_VALIDATE`) phải set `streamError={status:500,...}` ngay, không được fall-through thành lỗi mạng và retry 4 lần. Chỉ `chunk.code==='RateLimited'` mới set 429. Có ở cả node-streaming path và browser-SSE path trong `chat.js`. Test regression: `verify-audit-fixes.mjs` (R3b).
26. **`escapeInvalidBackslashesInStrings` không được gọi trên JSON ngoài fence `tool_call` (R2)**: Hàm này coi `\n`, `\t`, `\b`, `\f` là valid JSON escape, nhưng Qwen đôi khi trả Windows path như `C:\new\test.js` khiến `\n` bị decode thành newline âm thầm. `collectJsonObjects()` trong catch block chỉ dùng `stripTrailingCommasOutsideStrings()` — bỏ hoàn toàn `escapeInvalidBackslashesInStrings`. Nếu JSON vẫn không parse được, fall-through thay vì sửa ngầm. Hàm vẫn được dùng trong `parseLenientJson()` (fence explicit, an toàn hơn). `restoreArgsPathParams()` chạy sau parse để khôi phục control char về dạng escaped trong các tham số path-like (`path`, `file_path`, `filepath`, `filename`, `directory`, `dir`). Test regression: `verify-tools.mjs` ("Windows path with unescaped backslashes").
27. **`addNormalizedCalls` dùng `ctx.stopped` để break qua nhiều block (R8)**: `break` trong vòng lặp `rawCalls` chỉ thoát khỏi block hiện tại; block fence kế tiếp vẫn gọi `addNormalizedCalls` lần nữa. Khi gặp tool không khai báo hoặc arguments không parse được, phải set `ctx.stopped = true` đồng thời với `break`. Vòng lặp block bên ngoài kiểm tra `ctx.stopped` và `break` trước khi gọi `addNormalizedCalls` cho block tiếp theo. Test regression: `verify-tools.mjs` ("R8: undeclared tool first → breaks, subsequent valid call NOT executed"). Ngoài ra, block `malformed` cũng phải set `ctx.stopped = true` trước `continue` để ngăn block kế tiếp chạy (Fix D).
28. **Windows path (`C:\...`) và local path (`/home/...`) không có URL scheme bị từ chối ở attachment (Fix A)**: Regex `^[a-z][a-z0-9+-.]*:/` bắt được `file:/` và `ftp://` nhưng KHÔNG bắt được `C:\Users\...` hay `/home/user/img.png`. `attachmentSourceToBuffer()` kiểm tra `^[a-zA-Z]:[\\/]` (Windows — kể cả `C:/...` vì dạng này match URL-scheme regex trước nên từ chối qua đường `unsupported-scheme`) và `^\/[^/]+\/` kết hợp `!/^[A-Za-z0-9+/\s=]+$/` (Unix multi-segment path không phải base64 thuần). JPEG raw base64 bắt đầu bằng `/9j/` **không** bị từ chối vì chứa toàn ký tự base64 hợp lệ. Test regression: `verify-images.mjs`.
29. **`PATH_PARAM_KEYS` lookup phải case-insensitive và không bao gồm tham số đa dòng (Fix B / R9)**: `PATH_PARAM_KEYS.has(k)` phân biệt hoa thường — `filePath` (camelCase của OpenCode) bị bỏ sót nếu set chỉ có `filepath`. Fix: `PATH_PARAM_KEYS.has(k.toLowerCase())`. Các key `source`, `output`, `target`, `src`, `dest` đã bị loại khỏi set vì chúng có thể chứa nội dung file nhiều dòng; khôi phục `\n` trong đó sẽ hỏng nội dung. Set hiện tại: `['path', 'file_path', 'filepath', 'filename', 'directory', 'dir', 'workdir']`. Test regression: `verify-tools.mjs` ("Fix B" và "workdir").
30. **Soft nudge retry KHÔNG được ghi đè response gốc khi retry không ra tool call (Fix C)**: `chat.js` trong nhánh `isSoft` kèm preview bản nháp trước đó vào prompt retry (vì dùng chung `parent_id` nên nếu không kèm, Qwen không biết đang nói đến ví dụ nào) và chỉ dùng `retryResponse` nếu retry thành công **và** trả về ít nhất 1 tool call (`retryResult.merged.length > 0`). Nếu retry thất bại (500) hoặc model xác nhận "đó chỉ là ví dụ" (trả text, 0 tool call), `response` gốc được giữ nguyên và trả về client. Ngoài ra `shouldRetryToolCall()` kiểm tra `tool_choice === 'required'` TRƯỚC khi xét soft drops — `required` luôn trả `true`, không bị hạ xuống `'soft'` chỉ vì drop là mid-sentence. Test regression: `verify-tools.mjs` ("Fix C").

32. **`parseLenientJson` phải đánh dấu khi dùng `escapeInvalidBackslashesInStrings` (R9)**: Hàm này double-escape backslash để fix Windows path, nhưng JSON.parse sau đó giải mã `\\n` → newline, `\\t` → tab, `\\b` → backspace — hỏng `content`/`command` mà không báo lỗi. Fix: đánh dấu kết quả với Symbol `SLASH_REPAIR_SYM`. `addNormalizedCalls` kiểm tra — nếu có param nào **không** nằm trong `PATH_PARAM_KEYS` thì drop call và retry. Test: `verify-tools.mjs` "Fix 1 (R9)".
33. **Fence ` ```json ` chứa JSON hỏng có chữ ký tool call phải đặt `ctx.stopped` (R9)**: Block ` ```json ` bị `collectJsonObjects` extract được một phần dù JSON tổng thể không hợp lệ; nếu `rawBlock` fail `JSON.parse` **và** chứa cả `"name"` lẫn `"arguments"` → đánh dấu malformed và thêm vào `validBlocks`. Nhánh xử lý malformed trong vòng lặp sẽ set `ctx.stopped = true` ngăn fence kế tiếp (ví dụ `sh deploy.sh`) chạy. Block ` ```json ` không có `"arguments"` (config thường) không bị ảnh hưởng. Test: `verify-tools.mjs` "Fix 2 (R9)".
34. **Chống lặp thinking ở cả `catch` timeout và retry lỗi mạng + không bỏ âm thầm ảnh gửi lại (`fullReasoning` / `fileUpload.js`)**: `executeApiRequestWithNodeStreaming()` khai báo `fullReasoning` **ngoài `try`** để nhánh `catch` không bị `ReferenceError` khi lỗi sớm và luôn trả `hasStreamedReasoning: fullReasoning.length > 0`; `handleApiError()` dùng `applyRetryReasoningSuppression()` để tắt `onReasoning` ở cả retry timeout lẫn network error. Ở `collectImageParts()`, khi ảnh lỗi trong history bị gửi lại ở lượt hiện tại với `includeHistory: true`, ownership được chuyển sang `currentMessage` thay vì splice bỏ âm thầm, để `prepareOpenAIImages()` giữ placeholder `[image upload failed]` và báo lỗi lượt hiện tại đúng chuẩn. Test regression: `verify-resilience.mjs`, `verify-images.mjs`, `verify-audit-fixes.mjs`.

35. **Quota limit = HTTP 200 + `extra.update_member: true`, KHÔNG PHẢI `code: 'RateLimited'`**: Qwen web API không trả về HTTP 429 hay `code: 'RateLimited'` khi account hit daily quota. Thay vào đó nó trả về response thành công HTTP 200 với `choices[0].delta.extra.update_member === true` và content "You've reached today's Qwen4-Max limit...". Proxy detect pattern này qua `isQuotaLimitDelta()` trong `src/api/quotaLimit.js`, trả error terminal (không retry, không rotation) với `status: 429, quotaLimited: true`. Stream error dùng SSE `error` field + `proxy_notice`, **không inject vào `delta.content`** để history sạch. Test regression: `verify-quota.mjs`.
36. **Browser evaluate không được tham chiếu symbol Node; mirror phân loại lỗi phải có drift test**: Trong `page.evaluate()` chỉ tồn tại `data` — bản copy-paste `logWarn`/`payload` từ Node path từng ném `ReferenceError` bị `catch` từng chunk nuốt mất, khiến structured error (ContentFiltered, FAIL_SYS_USER_VALIDATE) biến thành `interrupted` và retry oan. Phân loại lỗi giờ nằm trong pure module `src/api/upstreamErrors.js` (`classifySseChunkError`, `classifyJsonErrorBody`, `rateLimitMessage`); browser path không import được ES module nên mang **mirror có marker** `// --- BEGIN/END upstream-classifiers mirror ---` trong `chat.js`, và `verify-audit-fixes.mjs` extract block đó chạy cùng bộ vector với module Node để chống drift (kể cả `isQuotaDelta` vs `isQuotaLimitDelta`). Log `[upstream-error]` của browser path bắn phía Node sau khi evaluate trả về. Fallback quota yêu cầu **≥2 pattern** — câu trả lời ngắn chứa riêng "switch to another model" không phải quota. Nhánh `stream=false` xét cả `success:false`/`data.code`/`data.error` lồng (trước chỉ xét `code`/`error` top-level). 429 RateLimited kèm cooldown parse từ `num` (giờ) trong message. `promptUser()`/`checkAuthentication()` guard `process.stdin.isTTY` — không treo stdin khi chạy unattended. Test regression: `verify-audit-fixes.mjs` (28 checks), `verify-quota.mjs` (12 checks).

## Quy ước code & test

- **Node.js**: Sử dụng ESM (`"type": "module"`), Node.js >= 18.
- **Không thay đổi tuỳ tiện đường truyền CDP**: Giữ nguyên cơ chế giao tiếp CDP hiện tại vì đã được kiểm chứng hoạt động ổn định.
- **Pure Modules**: Các module xử lý logic (như `toolCalls.js`, `reasoning.js`, `sessionSync.js`) phải giữ tính chất pure (không gắn chặt vào DOM hay I/O nặng) để có thể chạy test offline qua `scripts/core/verify-*.mjs`.
- **Bảo mật**: Tuyệt đối không commit thư mục `session/`, `.env`, `logs/`, `.opencode/`.
- **Chạy kiểm tra trước khi hoàn thành**:
  - Chạy cú pháp và 8 script verify offline:
    ```bash
    cmd /c "node --check index.js && node --check src/api/chat.js && node --check src/api/routes.js && node --check src/api/resilience.js && node --check src/utils/notify.js && node --check src/api/fileUpload.js && node --check src/api/reasoning.js && node --check src/api/toolCalls.js && node --check src/api/authRecovery.js && node --check src/api/quotaLimit.js && node --check src/api/upstreamErrors.js && node --check src/api/sessionSync.js && node scripts/core/verify-parser.mjs && node scripts/core/verify-reasoning.mjs && node scripts/core/verify-tools.mjs && node scripts/core/verify-images.mjs && node scripts/core/verify-auth-retry.mjs && node scripts/core/verify-resilience.mjs && node scripts/core/verify-quota.mjs && node scripts/core/verify-audit-fixes.mjs"
    ```

## Cập nhật tài liệu

| Khi có thay đổi | Cần cập nhật |
| --- | --- |
| Thêm/sửa route hoặc endpoint API | Bảng "Đọc file nào khi nào", Luồng xử lý chat |
| Thêm/đổi biến môi trường hoặc config mặc định | Mục "Config chính", `src/config.js` |
| Thay đổi cơ chế parse tool_calls hoặc reasoning | Mục "Tool Calling Protocol", "Reasoning & Thinking Stream", `verify-tools.mjs` |
| Phát hiện lỗi/gotcha mới từ Qwen | Mục "Điểm dễ vỡ (Learned the hard way)" |
| Đổi logic observer hoặc session sync | Mục "CDP Observer & Session Sync", `sessionHook.js` |
| Đổi retry network error hoặc xử lý captcha | Mục "Network retry & Captcha notification", `resilience.js`, `notify.js`, `verify-resilience.mjs` |
| Đổi đường streaming / xử lý protocol timeout | Mục 6 & 7, gotcha 18–19, `chat.js` (`executeApiRequestWithNodeStreaming`, `qwenCookieHeader`), `routes.js` (`collectOnly`), `verify-resilience.mjs` |
