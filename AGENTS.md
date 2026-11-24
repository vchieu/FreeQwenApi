# AGENTS.md — FreeQwenApi

Proxy Qwen Chat (chat.qwen.ai) → API tương thích OpenAI. Chạy qua **Chrome DevTools Protocol (CDP)**
điều khiển trực tiếp tab Chrome thật đã đăng nhập. Tự động inject CDP observer (`src/browser/sessionHook.js`)
bắt token và Baxia WAF headers từ traffic UI thật đẩy về `/api/session/sync`, không cần cài browser extension.
Cung cấp API OpenAI-compatible tại port mặc định 3264 (`http://localhost:3264/api` hoặc `/api/v1/*`).

File này mô tả **cấu trúc, luồng hoạt động và trạng thái hiện tại của codebase**.
Dành cho AI agents đọc để nhanh chóng nắm bắt source code và tránh lặp lại các lỗi đã fix.

## Chạy & kiểm tra

```bash
npm install
npm run start:cdp                       # Khởi động Chrome CDP chuyên dụng + chạy proxy
```

`start:cdp` tự động mở (hoặc reuse) cửa sổ Chrome riêng với profile lưu session (`--remote-debugging-port=9222`,
`--user-data-dir=...`) và chạy proxy không tương tác (`SKIP_ACCOUNT_MENU=1`, `NON_INTERACTIVE=1`,
`QWEN_CDP_URL=http://127.0.0.1:9222`). Lần đầu chạy cần đăng nhập tài khoản Qwen trên cửa sổ Chrome vừa mở.

Các lệnh tiện ích khác:

| Lệnh | Mục đích |
| --- | --- |
| `npm start` | Chạy proxy tương tác thông thường (menu chọn/thêm account) |
| `npm run auth` | Thêm, liệt kê, đăng nhập lại hoặc xoá tài khoản Qwen (`scripts/core/auth.js`) |
| `npm run models:sync` | Đồng bộ danh sách model từ Qwen về `src/AvailableModels.txt` |
| `npm run smoke` | Chạy smoke test API (`scripts/inspect/smoke_test.js`) |

Kiểm tra cú pháp & kiểm tra offline (không cần browser, không cần network):

```bash
# Cú pháp (Windows CMD)
node --check index.js && node --check src/api/chat.js && node --check src/api/routes.js && node --check src/api/resilience.js && node --check src/utils/notify.js && node --check src/api/fileUpload.js && node --check src/api/reasoning.js && node --check src/api/toolCalls.js && node --check src/api/authRecovery.js

# Hoặc PowerShell
node --check index.js; node --check src/api/chat.js; node --check src/api/routes.js; node --check src/api/resilience.js; node --check src/utils/notify.js; node --check src/api/fileUpload.js; node --check src/api/reasoning.js; node --check src/api/toolCalls.js; node --check src/api/authRecovery.js

# Chạy bộ verify offline
node scripts/core/verify-parser.mjs            # Kiểm tra parser SSE câu trả lời
node scripts/core/verify-reasoning.mjs         # Kiểm tra mapping reasoning_effort & thinking stream
node scripts/core/verify-tools.mjs             # Kiểm tra parser tool_calls, format prompt, recovery JSON, text tool call
node scripts/core/verify-auth-retry.mjs        # Kiểm tra nhận diện 401, chọn token xoay, chọn tab proxy-owned
node scripts/core/verify-images.mjs            # Kiểm tra tách/chỉ upload ảnh lượt hiện tại
node scripts/core/verify-resilience.mjs        # Kiểm tra retry network error, phát hiện captcha, lệnh notification
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
| `index.js` | Express server entrypoint; nạp `src/env.js`, mount `/api`, dashboard UI, graceful shutdown | Khởi động server, cấu hình CORS, middleware parse JSON, port bind |
| `src/api/routes.js` | Toàn bộ router HTTP: `/chat/completions`, `/v1/chat/completions`, `/models`, images, videos, tasks | Xử lý request, resolve chat_id/parent_id, map model, stream SSE, route API |
| `src/api/chat.js` | Giao tiếp core với Qwen: build payload, header Baxia, `sendMessage()`, `executeApiRequest()`, page pool, delete chat | Lỗi kết nối Qwen, request header WAF, gọi browser evaluate, vòng đời chat |
| `src/api/toolCalls.js` | Pure module: `messagesToQwenPrompt()` (chèn `# Tool Use`), `parseToolCalls()` (fence/XML + JSON trần/prose/nhiều call), lenient JSON parser | Sửa cách gọi tool, định dạng tool_call fences, recovery lỗi JSON arguments |
| `src/api/authRecovery.js` | Pure module: nhận diện 401, chọn token xoay hợp lệ, chọn tab proxy-owned để reload | Sửa luồng retry 401, chờ/xoay token |
| `src/api/resilience.js` | Pure module: phân loại lỗi mạng có thể retry, nhận diện tín hiệu captcha (WAF `_____tmd_____`, slider `nc_1_nocaptcha`, title `Verification`), text thông báo | Sửa retry network error, phát hiện/handle captcha |
| `src/utils/notify.js` | Fire-and-forget desktop alert (Windows MessageBox, macOS `osascript`, Linux `notify-send`); `notificationCommand()` pure để test | Sửa cách notify user khi cần giải captcha |
| `src/api/reasoning.js` | Pure module: map `reasoning_effort` → Qwen `feature_config`, accumulator stream thinking | Chỉnh chế độ suy nghĩ (Fast/Auto/Thinking), xử lý stream suy nghĩ |
| `src/api/sessionSync.js` | Nhận & validate token/Baxia headers từ CDP observer; ghi file atomic `baxia.json`, update `tokens.json` | Cập nhật WAF headers, logic lọc header, lưu trữ token tự động |
| `src/api/tokenManager.js` | Quản lý danh sách tài khoản, trạng thái rate-limit, đánh dấu invalid / phục hồi | Đọc/ghi `session/tokens.json`, giải mã JWT, xoay vòng tài khoản |
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
| `scripts/core/verify-*.mjs` | Bộ 6 script test offline (parser, reasoning, tools, images, auth-retry, resilience) | Kiểm tra regression logic cốt lõi mà không cần mở trình duyệt |
| `session/` | Thư mục runtime gitignored (`baxia.json`, `tokens.json`, `history/`) | Xem trạng thái token, header WAF thực tế |

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
- `src/api/sessionSync.js` xác thực JWT, kiểm tra headers, và ghi nguyên tử (`writeJsonAtomic`) vào `session/baxia.json` và cập nhật `session/tokens.json`. Không cần can thiệp thủ công hay extension.

### 3. Token Management & Rotation
- Qwen sử dụng token ngắn hạn trong trình duyệt (`localStorage.getItem('token')`).
- File `session/tokens.json` có thể chứa token dài hạn cũ hoặc đã hết hạn. Hàm `readTokenFromQwenTab()` luôn ưu tiên đọc token sống trực tiếp từ tab Chrome (tuỳ chọn `includeOwned` để đọc cả tab proxy-owned sau khi ép refresh).
- Bỏ qua các token JWT có thời gian hết hạn dưới 30 giây và không bao giờ retry lại đúng token vừa bị từ chối (`isUsableRefreshedToken()`).
- Khi gặp lỗi `401 Unauthorized` với browser token: chờ ngắn token xoay tự nhiên, nếu không có thì `recoverBrowserToken()` reload **tab do proxy sở hữu** (`pickProxyOwnedQwenPage()`, không đụng tab người dùng) sau khi xoá `token` trong `localStorage` để ép SPA cấp token mới, rồi retry (tối đa `MAX_RETRY_COUNT`) trước khi đánh dấu tài khoản invalid. Dùng chung cho 401 lúc tạo chat và lúc gửi message.
- `markValidForToken()` phục hồi cờ invalid dựa trên decoded payload ID.

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
- `parseToolCalls()` chấp nhận cả JSON trần/prose + JSON/nhiều JSON trần liên tiếp trong cùng một turn, miễn object có shape tool (`name` + `arguments`). JSON thường không có shape tool vẫn giữ nguyên là text; fence bị từ chối do có prose cùng dòng vẫn là text (được coi là mô tả, không phải lời gọi).
- Parser chịu lỗi (lenient JSON repair: tự động sửa lỗi thiếu arguments key dạng `{"name":"foo",{"path":"x"}}`, sửa trailing commas, single quotes).
- Lọc bỏ các tool không khai báo (ví dụ `code_interpreter` tích hợp của Qwen) hoặc thiếu param bắt buộc.
- Phần chữ giải thích (prose) đi cùng tool call được bảo toàn trong `content`, các block fence/JSON đã parse được tách sạch sẽ.
- `sendMessage()` gom hậu xử lý tool call thành `finalizeToolCallsInResponse()` gọi lại sau cả nudge retry: response thứ hai cũng luôn có `tool_calls_normalized`, `tool_calls_clean_text`, không để tool call sót lại thành text. `routes.js` giữ prose đó thay vì ép `content` về `''`.

### 7. Network retry & Captcha notification
- `fetch` trong tab Qwen đôi khi chết giữa chừng (`TypeError: network error`, `socket hang up`, `fetch failed`) do WAF reset hoặc tab chuyển hướng. `src/api/resilience.js` phân loại đây là lỗi mạng tạm thời: `handleApiError()` chờ `RETRY_DELAY` rồi retry **cùng chat** (giữ nguyên `tools`/`systemMessage`), tối đa `MAX_RETRY_COUNT`. HTTP 4xx/5xx và response đã stream một phần (`hasStreamedChunks`) **không** retry để tránh nhân đôi content.
- Captcha được nhận diện sớm cả trước lẫn trong lúc request (`readCaptchaSignal()` + `startCaptchaWatcher()`): URL `_____tmd_____`, marker slider `nc_1_nocaptcha`/`baxia-dialog`, hoặc title `Verification`. Khi phát hiện: bắn desktop notification ngay (`src/utils/notify.js`: MessageBox trên Windows, `osascript` trên macOS, `notify-send` trên Linux) và gửi chunk SSE `Please resolve captcha to continue...` cho client (kể cả route có `tools` qua `onCaptcha`).
- Proxy tiếp tục poll tab (`CAPTCHA_POLL_INTERVAL_MS`) tối đa `CAPTCHA_WAIT_TIMEOUT_MS`; sau khi user kéo slider xong tự động retry (trên chat mới, xem bên dưới). Nếu hết timeout trả `{error, verification:true, captcha:true}` để client biết thay vì im lặng đến lúc `PAGE_TIMEOUT`. Không bao giờ tự solve captcha bằng code.
- **Chỉ xét frame visible**: Qwen giữ lại iframe 0x0 `baxia-dialog-content` (`_____tmd_____/punish`) sau khi đã giải captcha. `readCaptchaSignal()` dùng `frame.frameElement().boundingBox()` (`isVisibleBox()`) để bỏ frame ẩn; nếu quét URL mọi frame thì `waitForCaptchaClear()` sẽ chạy đúng 300s rồi trả lỗi dù user đã kéo slider xong.
- **Sau captcha phải retry chat MỚI**: fetch trong tab chết khi WAF chặn nhưng phía Qwen vẫn đang generate. Gửi lại vào cùng `chat_id` bị `500 {"data":{"code":"CHAT_IN_PROGRESS","details":"The chat is in progress!"}}`. `handleApiError()` nhận diện `isChatInProgress()`, xoá chat cũ rồi retry với `chatId=null/parentId=null` (history vẫn nằm trong `messages`). Đường captcha-recovery cũng làm vậy luôn, không đợi dò lỗi.

### 8. Media & Async Tasks
- Hỗ trợ Text-to-Image (`/api/images/generations`) qua Qwen Chat (`chatType: t2i`) và DashScope fallback.
- Hỗ trợ Text-to-Video (`/api/videos/generations`) qua Qwen Chat (`chatType: t2v`).
- Polling trạng thái tác vụ qua `/api/tasks/status/:taskId`.
- Ảnh đầu vào OpenAI (`image_url` dạng data URL hoặc http URL) trong `/api/chat/completions` và `/api/v1/chat/completions` được tải lên OSS Qwen rồi đưa vào `messages[].files` theo đúng shape UI; nội dung `content` chỉ giữ phần text.

## Điểm dễ vỡ (Learned the hard way)

1. **Ràng buộc Baxia x5secdata**: `x5secdata` trong `session/baxia.json` bị gắn với `chat_id`. Hãy để observer tự động cập nhật hoặc dùng capture hợp lệ.
2. **x-request-id trùng lặp hoặc cũ**: Bắt buộc strip `x-request-id` có sẵn và chỉ chèn 1 UUID duy nhất. 2 ID gây lỗi 500, ID cũ gây lỗi 403 `FAIL_SYS_USER_VALIDATE`.
3. **Headless Timeout**: Không chạy Chrome headless tự tạo mà không có flag stealth/profile thật. Luôn ưu tiên đường CDP nối vào Chrome thật (`start:cdp`).
4. **Token hết hạn**: Không tin tưởng tuyệt đối vào token trong file `tokens.json`. Token trong `localStorage` của tab Qwen mới là nguồn chuẩn.
5. **Slider Captcha (`nc_1_nocaptcha`)**: Nếu xuất hiện slider captcha hoặc trang chuyển hướng về `_____tmd_____/report`, **dừng tự động ngay lập tức** (không cố giải bằng code), bắn desktop notification + SSE notice cho client, rồi chờ user kéo captcha và retry cùng chat. Không restart browser như cũ (việc đó làm mất tab user đang thao tác). Test regression: `verify-resilience.mjs`.
6. **Chat biến mất trên web Qwen**: Khi `AUTO_DELETE_CHATS=all` (mặc định), proxy tự động gọi `deleteChatV2()` để dọn dẹp các chat tạm sinh ra. Đây là hành vi bình thường, không phải lỗi.
7. **OpenWebUI Meta Request**: Các request kiểm tra tiêu đề/tags từ Open WebUI (`isOpenWebUiMetaRequest`) được tách ra xử lý riêng để không làm hỏng context hội thoại chính.
8. **401 khi tạo chat cũng có dạng HTTP 200**: `createChatV2()` có thể nhận `200` với body `{success:false, data:{code:"unauthorized", details:"401 Unauthorized"}}`. Phải coi như 401, dùng `recoverBrowserToken()` (chờ xoay ngắn → reload tab proxy-owned để ép token mới, loại trừ token vừa bị từ chối) rồi retry tối đa `MAX_RETRY_COUNT`; không trả lỗi ngay cho client. Token dùng cho retry cũng phải được giữ nguyên khi gửi message. Test regression: `verify-auth-retry.mjs`.
9. **STS upload đã chuyển sang `/api/v2/files/getstsToken`**: URL v1 trả `405`. Response có dạng `{success:true, request_id, data:{...}}` — `getStsToken()` phải unwrap lấy `data` thì `uploadFile()` mới thấy `file_path`/`file_id`. Ảnh sau khi upload phải nằm ở `messages[].files` (type `image`, `file_class: vision`, `url` là signed OSS URL), không được nhét vào `content`.
10. **`messages[].content` của Qwen Web phải là string**: Sau khi tách các part `image_url` ra khỏi content của OpenAI, nếu còn lại mảng part (`[{type:'text',...}]`) thì Qwen trả `internal_error` ngay. `prepareOpenAIImages()` phải gom các part text còn lại thành một string trước khi gọi `sendMessage()`.
11. **Chỉ upload ảnh của lượt hiện tại**: Client OpenAI (OpenWebUI...) gửi lại toàn bộ history, trong đó có cả ảnh của các lượt trước. `collectImageParts()` chỉ chọn ảnh trong user message cuối; ảnh cũ được thay bằng placeholder `[image]` và không upload lại, nếu không mỗi request sẽ đính lại toàn bộ ảnh cũ vào chat Qwen. Test regression: `verify-images.mjs`.
12. **Tool call có thể là text trần**: Qwen đôi khi trả `{"name":"...","arguments":{...}}` không có fence, kèm prose hoặc nhiều call liên tiếp. `parseToolCalls()` phải quét mọi object có shape tool, cắt khỏi `content` (fence hợp lệ đứng riêng vẫn được parse như cũ; fence có prose cùng dòng là mô tả và giữ nguyên). `finalizeToolCallsInResponse()` phải chạy lại sau nudge retry (`_toolRetryDone`) nếu không tool call sẽ sót lại thành text như đã thấy với `todowrite`. Test regression: `verify-tools.mjs`.
13. **`TypeError: network error` không được trả thẳng cho client**: Đây là `fetch` trong tab bị WAF/reset chặng giữa SSE. `handleApiError()` phải retry cùng chat (tối đa `MAX_RETRY_COUNT`). Đường node-streaming phải gắn `hasStreamedChunks` ngay trong `catch`, nếu không response sẽ bị coi là chưa stream và fallback sang browser → gửi lại cả nội dung cũ. Test regression: `verify-resilience.mjs`.
14. **Captcha mà user không để ý thì request đứng timeout**: `checkVerification()` cũ chỉ đọc title và `promptUser()` trên stdin (hang ở `NON_INTERACTIVE`). Giờ dùng `readCaptchaSignal()` + watcher poll tab; SSE notice + desktop alert được bắn ngay, client thấy thông báo thay vì đợi `PAGE_TIMEOUT`. `routes.js` phải truyền `onCaptcha` ngay cả khi route có `tools` (lúc đó `streamingCallback` bị tắt). Test regression: `verify-resilience.mjs`.
15. **Popup Windows biến mất khi spawn notification**: `spawn('powershell.exe', ..., {detached:true})` và cờ `-NonInteractive` làm `MessageBox::Show()` trả về ngay **không hiện UI**. Phải spawnAttached (`detached` mặc định `false`) rồi `child.unref()`; giữ `windowsHide:false`. Ngoài ra slider captcha nằm trong iframe và marker là id/class (`nc_1_nocaptcha`), không phải `innerText` — `readCaptchaSignal()` phải quét `page.frames()` + thuộc tính phần tử visible.
16. **Client đứng sau khi user đã kéo slider xong**: Qwen không xoá iframe 0x0 `baxia-dialog-content` (`_____tmd_____/punish`) sau khi solve. Nếu `readCaptchaSignal()` quét URL **mọi** frame, `waitForCaptchaClear()` thấy captcha liên tục và chỉ thoát sau 300s rồi trả lỗi — client tưởng proxy treo. Phải lọc frame bằng `frame.frameElement().boundingBox()`/`isVisibleBox()` trước khi check URL lẫn HTML. Test regression: `verify-resilience.mjs`.
17. **`CHAT_IN_PROGRESS` sau captcha**: fetch chết ở browser nhưng Qwen vẫn generate; retry cùng `chat_id` nhận `500 {"data":{"code":"CHAT_IN_PROGRESS","details":"The chat is in progress!"}}`. `isChatInProgress()` (pure) + `handleApiError()` phải xoá chat cũ rồi retry với `chatId=null/parentId=null` thay vì trả lỗi cho client. Log cũ ghi `Error getting response: undefined` vì chỉ đọc `response.error`; giờ ưu tiên `errorBody`. Test regression: `verify-resilience.mjs`.

## Quy ước code & test

- **Node.js**: Sử dụng ESM (`"type": "module"`), Node.js >= 18.
- **Không thay đổi tuỳ tiện đường truyền CDP**: Giữ nguyên cơ chế giao tiếp CDP hiện tại vì đã được kiểm chứng hoạt động ổn định.
- **Pure Modules**: Các module xử lý logic (như `toolCalls.js`, `reasoning.js`, `sessionSync.js`) phải giữ tính chất pure (không gắn chặt vào DOM hay I/O nặng) để có thể chạy test offline qua `scripts/core/verify-*.mjs`.
- **Bảo mật**: Tuyệt đối không commit thư mục `session/`, `.env`, `logs/`, `.opencode/`.
- **Chạy kiểm tra trước khi hoàn thành**:
  - Chạy cú pháp và 6 script verify offline:
    ```bash
    cmd /c "node --check index.js && node --check src/api/chat.js && node --check src/api/routes.js && node --check src/api/resilience.js && node --check src/utils/notify.js && node --check src/api/fileUpload.js && node --check src/api/reasoning.js && node --check src/api/toolCalls.js && node --check src/api/authRecovery.js && node scripts/core/verify-parser.mjs && node scripts/core/verify-reasoning.mjs && node scripts/core/verify-tools.mjs && node scripts/core/verify-images.mjs && node scripts/core/verify-auth-retry.mjs && node scripts/core/verify-resilience.mjs"
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
