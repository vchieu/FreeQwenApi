import { getBrowserContext } from '../browser/browser.js';
import { logInfo, logError } from '../logger/index.js';
import { getAuthToken, extractAuthToken, pagePool, loadBaxiaHeaders, resolveAuthToken } from './chat.js';
import { decodeTokenInfo } from './tokenManager.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { STS_TOKEN_API_URL, OSS_SDK_URL, UPLOADS_DIR } from '../config.js';

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const DOCUMENT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt'];
const DEFAULT_FILE_TYPE = 'file';
const IMAGE_FILE_TYPE = 'image';
const DOCUMENT_FILE_TYPE = 'document';

const MIME_EXTENSIONS = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
};
const EXTENSION_MIMES = Object.fromEntries(
    Object.entries(MIME_EXTENSIONS).map(([mime, ext]) => [ext, mime])
);
const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/;
const UPLOAD_CACHE_MAX = 200;
const UPLOAD_CACHE_TTL_MS = 15 * 60 * 1000;
const uploadedAttachmentCache = new Map();

function extFromMime(mime, fallbackName = '') {
    const mapped = MIME_EXTENSIONS[String(mime || '').toLowerCase()];
    if (mapped) return mapped;
    const ext = fallbackName ? path.extname(fallbackName).toLowerCase() : '';
    return ext || '.png';
}

function mimeFromUrl(url) {
    try {
        return EXTENSION_MIMES[path.extname(new URL(url).pathname).toLowerCase()] || null;
    } catch {
        return null;
    }
}

function attachmentFromPart(part) {
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'image_url') {
        const source = typeof part.image_url === 'string' ? part.image_url : (part.image_url?.url || null);
        return source ? { kind: 'image', source, filename: null, mime: null } : null;
    }
    if (part.type === 'image') {
        const source = part.image || part.url || part.file;
        return typeof source === 'string' ? { kind: 'image', source, filename: null, mime: null } : null;
    }
    if (part.type === 'file' || part.type === 'input_file') {
        const fileObj = (part.file && typeof part.file === 'object') ? part.file : part;
        const rawSource = fileObj.file_data || fileObj.data || fileObj.url || fileObj.file_url
            || (typeof part.file === 'string' && (part.file.startsWith('data:') || /^https?:\/\//i.test(part.file)) ? part.file : null);
        const filename = fileObj.filename || fileObj.name || part.filename || part.name || 'document.pdf';
        const mime = fileObj.mime_type || fileObj.content_type || EXTENSION_MIMES[path.extname(filename).toLowerCase()] || 'application/pdf';
        return rawSource ? { kind: 'file', source: rawSource, filename, mime } : null;
    }
    return null;
}

export async function attachmentSourceToBuffer(source, fallbackMime = 'image/png', fallbackName = '') {
    if (typeof source !== 'string' || !source.trim()) throw new Error('Empty attachment source');

    if (source.startsWith('data:')) {
        const match = source.match(DATA_URL_RE);
        if (!match) throw new Error('Invalid attachment data URL');
        const mime = (match[1] || fallbackMime || 'application/octet-stream').toLowerCase();
        const buffer = match[2]
            ? Buffer.from(match[3], 'base64')
            : Buffer.from(decodeURIComponent(match[3]), 'utf8');
        if (!buffer.length) throw new Error('Empty attachment data');
        return { buffer, mime, ext: extFromMime(mime, fallbackName), lastModified: Date.now() };
    }

    if (/^https?:\/\//i.test(source)) {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`Failed to download attachment: HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) throw new Error('Empty attachment data');
        const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
            || mimeFromUrl(source)
            || fallbackMime
            || 'application/octet-stream';
        return { buffer, mime, ext: extFromMime(mime, fallbackName), lastModified: Date.now() };
    }

    // Raw base64 (OpenAI file_data sometimes omits data: prefix).
    // Reject any URL-like string first so that "file:///path/to/img.png" or
    // other unknown schemes are not silently decoded as garbage base64 (R9).
    // Reject any URL-like string (including single-slash file:/path) so it is not
    // silently decoded as garbage base64. The regex catches both :// and :/ forms.
    if (/^[a-z][a-z0-9+\-.]*:\//i.test(source)) {
        throw new Error(`Unsupported URL scheme for attachment: ${source.split(':')[0]}`);
    }
    // Reject Windows absolute paths (C:\... or C:/...) that have no URL scheme.
    // These cannot be base64 and would decode as garbage (Fix #7 / R9 extension).
    // Do NOT reject Unix-style strings here: JPEG base64 starts with /9j/ which
    // matches /^\/[a-zA-Z0-9]/ but is perfectly valid base64 — only reject strings
    // that look like a real local path (contain path separators after the first char).
    if (/^[a-zA-Z]:[\\\/]/.test(source)) {
        throw new Error(`Local filesystem path is not a valid attachment source: ${source.slice(0, 60)}`);
    }
    // Reject strings that are clearly local paths (/home/user/..., /tmp/...) but NOT
    // base64: a local path contains a '/' after a non-base64 character sequence or has
    // multiple path segments. We detect this by checking for characters illegal in base64.
    // Base64 alphabet: A-Z a-z 0-9 + / = and optional whitespace. A local path like
    // /home/me/shot.png contains letters legal in base64 so we can't use alphabet alone;
    // instead check for a path separator followed by more path text (second slash means
    // it really is a path, not a one-character base64 prefix).
    if (/^\/[^/]+\//.test(source) && !/^[A-Za-z0-9+/\s=]+$/.test(source)) {
        throw new Error(`Local filesystem path is not a valid attachment source: ${source.slice(0, 60)}`);
    }
    if (fallbackMime) {
        const buffer = Buffer.from(source, 'base64');
        if (buffer.length > 0) {
            return { buffer, mime: fallbackMime, ext: extFromMime(fallbackMime, fallbackName), lastModified: Date.now() };
        }
    }
    throw new Error('Unsupported attachment source');
}

function buildQwenAttachmentFile(stsData, uploadResult, { filename, size, mime, lastModified, kind = 'image' }, token = null) {
    const id = stsData.file_id || uploadResult.fileId;
    const now = Date.now();
    const activeToken = token || getAuthToken();
    const userId = activeToken ? decodeTokenInfo(activeToken).accountId : null;
    const isImage = kind === 'image' || String(mime || '').startsWith('image/');
    const ext = path.extname(filename || '').toLowerCase();

    // Mirror the shape the real Qwen UI sends in messages[].files so the web
    // backend recognises the image/document attachment.
    return {
        type: isImage ? 'image' : 'file',
        file: {
            created_at: now,
            data: {},
            filename,
            hash: null,
            id,
            user_id: userId,
            meta: { name: filename, size, content_type: mime },
            update_at: now,
            lastModified,
            name: filename,
            webkitRelativePath: '',
            size,
            type: mime
        },
        id,
        url: uploadResult.url || stsData.file_url,
        name: filename,
        collection_name: '',
        progress: 100,
        status: 'uploaded',
        greenNet: 'success',
        size,
        error: '',
        itemId: crypto.randomUUID(),
        file_type: mime,
        showType: isImage ? 'image' : 'file',
        file_class: isImage ? 'vision' : (DOCUMENT_EXTENSIONS.includes(ext) ? 'document' : 'default'),
        uploadTaskId: crypto.randomUUID()
    };
}

function getCachedAttachment(cacheKey) {
    const entry = uploadedAttachmentCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        uploadedAttachmentCache.delete(cacheKey);
        return null;
    }
    return {
        ...entry.value,
        itemId: crypto.randomUUID(),
        uploadTaskId: crypto.randomUUID()
    };
}

function setCachedAttachment(cacheKey, value) {
    if (uploadedAttachmentCache.size >= UPLOAD_CACHE_MAX) {
        const oldestKey = uploadedAttachmentCache.keys().next().value;
        if (oldestKey) uploadedAttachmentCache.delete(oldestKey);
    }
    uploadedAttachmentCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + UPLOAD_CACHE_TTL_MS
    });
}

async function uploadAttachmentSource({ source, kind = 'image', filename: hintName = null, mime: hintMime = null }, tokenObj = null) {
    const { buffer, mime, ext, lastModified } = await attachmentSourceToBuffer(
        source,
        hintMime || (kind === 'image' ? 'image/png' : 'application/pdf'),
        hintName || ''
    );
    const activeToken = tokenObj?.token || null;
    const accountScope = tokenObj?.id || (activeToken ? decodeTokenInfo(activeToken).accountId : null) || 'default';
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const cacheKey = `${accountScope}:${kind}:${mime}:${hash}`;
    const cached = getCachedAttachment(cacheKey);
    if (cached) {
        logInfo(`[attachment] Cache hit for ${kind} (${hash.slice(0, 12)}, ${buffer.length} bytes)`);
        return cached;
    }

    const filename = hintName || `${kind}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
    const isImage = kind === 'image' || mime.startsWith('image/');
    const stsFileType = isImage
        ? IMAGE_FILE_TYPE
        : (DOCUMENT_EXTENSIONS.includes(ext.toLowerCase()) ? DOCUMENT_FILE_TYPE : DEFAULT_FILE_TYPE);

    const tempDir = path.resolve(process.cwd(), UPLOADS_DIR);
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${crypto.randomUUID()}${ext}`);
    try {
        fs.writeFileSync(tempPath, buffer);
        logInfo(`[attachment] Uploading ${filename} (${buffer.length} bytes, ${mime}, type=${stsFileType})`);
        const stsData = await getStsToken({ filename, filesize: String(buffer.length), filetype: stsFileType }, tokenObj);
        const uploaded = await uploadFile(tempPath, stsData);
        const fileObj = buildQwenAttachmentFile(stsData, uploaded, { filename, size: buffer.length, mime, lastModified, kind }, activeToken);
        setCachedAttachment(cacheKey, fileObj);
        return fileObj;
    } finally {
        try { fs.unlinkSync(tempPath); } catch { /* already removed */ }
    }
}

// Qwen Web accepts a plain string for messages[].content. OpenAI clients send
// arrays of parts; once images/files are moved into files[] we collapse what
// remains back into a string so the payload matches a real UI request.
function collapseImageMessageContent(content) {
    if (!Array.isArray(content)) return content;
    const chunks = [];
    for (const part of content) {
        if (!part) continue;
        if (typeof part === 'string') {
            chunks.push(part);
        } else if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
            chunks.push(part.text || '');
        } else if (part.type === 'file' || part.type === 'input_file') {
            const name = part.file?.filename || part.file?.name || part.filename || part.name
                || (typeof part.file === 'string' ? part.file : '') || part.file?.file_id || 'attachment';
            chunks.push(`[file: ${name}]`);
        } else {
            // Preserve any uncommon non-image part in a readable text form.
            const value = part.url || (typeof part.file === 'string' ? part.file : part.file?.filename) || part.name || '';
            chunks.push(`[${part.type}: ${value}]`);
        }
    }
    return chunks.filter(Boolean).join('\n');
}

// Pure selection step:
// - When continuing an existing Qwen chat (`includeHistory: false`, default),
//   only the CURRENT (last) user turn is uploaded because earlier turns already
//   live in Qwen's server-side history.
// - When creating a new Qwen chat (`includeHistory: true`, e.g. stateless or
//   tool-calling requests), ALL user turns' attachments are collected so
//   earlier images/files do not disappear on turn 2+.
export function collectImageParts(messages, { includeHistory = false } = {}) {
    const result = { currentParts: [], touchedMessages: new Set(), currentMessage: null };
    if (!Array.isArray(messages)) return result;

    const userMessages = messages.filter(msg => msg && msg.role === 'user');
    if (!userMessages.length) return result;
    const currentMessage = userMessages[userMessages.length - 1];
    result.currentMessage = currentMessage;

    const seenBySource = new Map();
    for (const msg of userMessages) {
        if (!Array.isArray(msg.content)) continue;
        // Snapshot - msg.content is mutated while attachment parts are stripped.
        for (const part of [...msg.content]) {
            const attachment = attachmentFromPart(part);
            if (!attachment) continue;
            result.touchedMessages.add(msg);

            const placeholder = attachment.kind === 'image'
                ? '[image]'
                : `[file: ${attachment.filename || 'attachment'}]`;

            let placeholderNode = null;
            const replace = (text) => {
                const index = msg.content.indexOf(part);
                if (index !== -1) {
                    placeholderNode = { type: 'text', text };
                    msg.content.splice(index, 1, placeholderNode);
                }
            };

            if (msg !== currentMessage) {
                replace(placeholder);
                if (!includeHistory) continue;
            }
            const existing = seenBySource.get(attachment.source);
            if (existing) {
                // Avoid uploading identical attachments multiple times in one request.
                if (msg === currentMessage && existing.msg !== currentMessage) {
                    // Promote ownership to currentMessage: if a previously failed
                    // attachment is re-sent in the current turn with includeHistory:true,
                    // failures must be treated as current-turn errors (with placeholder)
                    // rather than silently spliced out of currentMessage.
                    existing.msg = currentMessage;
                    existing.part = part;
                    existing.placeholderNode = null;
                } else if (msg === currentMessage) {
                    const index = msg.content.indexOf(part);
                    if (index !== -1) msg.content.splice(index, 1);
                }
                continue;
            }
            const entry = { msg, part, placeholderNode, ...attachment };
            seenBySource.set(attachment.source, entry);
            result.currentParts.push(entry);
        }
    }
    return result;
}

// Converts OpenAI `image_url` / internal `image` / `file` / `input_file` parts
// into Qwen OSS attachments, then strips them from content - Qwen expects
// attachments in messages[].files, not inside messages[].content.
export async function prepareOpenAIImages(messages, { includeHistory = false, tokenObj = null } = {}) {
    if (!Array.isArray(messages)) return { files: [], error: null, tokenObj: null };

    const { currentParts, touchedMessages, currentMessage } = collectImageParts(messages, { includeHistory });
    if (!touchedMessages.size) return { files: [], error: null, tokenObj: null };

    let resolvedTokenObj = tokenObj;
    if (!resolvedTokenObj && currentParts.length > 0) {
        const browserContext = validateBrowserContext();
        resolvedTokenObj = await resolveAuthToken(browserContext);
        if (!resolvedTokenObj?.token) {
            return { files: [], error: 'Failed to get auth token for attachment upload', tokenObj: null };
        }
    }

    const files = [];
    const currentTurnErrors = [];
    const allErrors = [];
    for (const item of currentParts) {
        const { msg, part, kind, placeholderNode } = item;
        const isCurrentTurn = msg === currentMessage;
        try {
            files.push(await uploadAttachmentSource(item, resolvedTokenObj));
            const index = msg.content.indexOf(part);
            if (index !== -1) msg.content.splice(index, 1);
        } catch (error) {
            logError(`[attachment] Failed to upload ${kind}${isCurrentTurn ? '' : ' (history)'}: ${error.message}`);
            allErrors.push(error.message);
            if (isCurrentTurn) currentTurnErrors.push(error.message);
            const failText = kind === 'image' ? '[image upload failed]' : '[file upload failed]';
            const index = msg.content.indexOf(part);
            if (index !== -1) {
                msg.content.splice(index, 1, { type: 'text', text: failText });
            } else if (placeholderNode) {
                placeholderNode.text = failText;
            }
        }
    }

    // Collapse only messages we changed, after every attachment part was removed.
    for (const msg of touchedMessages) {
        msg.content = collapseImageMessageContent(msg.content);
    }

    // Only block the whole request when a *current-turn* attachment failed and
    // nothing at all was uploaded. History failures leave a placeholder text in
    // content and are silently degraded — an old 404 image must not freeze the
    // entire conversation (R4 regression).
    const currentTurnHadAttachments = currentParts.some(item => item.msg === currentMessage);
    if (currentTurnHadAttachments && !files.length && currentTurnErrors.length) {
        return { files: [], error: `Attachment upload failed: ${currentTurnErrors[0]}`, tokenObj: resolvedTokenObj };
    }
    // A text-less attachment message still needs a prompt for Qwen to answer.
    for (const msg of touchedMessages) {
        if (!String(msg.content || '').trim()) {
            msg.content = msg === currentMessage
                ? 'Please describe the attached content.'
                : '[attachment]';
        }
    }
    return { files, error: null, tokenObj: resolvedTokenObj };
}

function validateBrowserContext() {
    const browserContext = getBrowserContext();
    if (!browserContext) throw new Error('Browser is not initialized');
    return browserContext;
}

async function validateAuthToken(browserContext, tokenObj = null) {
    if (tokenObj?.token) return tokenObj.token;

    const resolved = await resolveAuthToken(browserContext);
    if (resolved?.token) return resolved.token;

    let token = getAuthToken();
    if (!token) {
        logInfo('Auth token not found in memory, trying to extract from browser');
        token = await extractAuthToken(browserContext);
        if (!token) throw new Error('Failed to get auth token');
    }
    return token;
}

export async function getStsToken(fileInfo, tokenObj = null) {
    const browserContext = validateBrowserContext();
    const token = await validateAuthToken(browserContext, tokenObj);
    logInfo(`Requesting STS token for file: ${fileInfo.filename}`);

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);
        // The real UI sends the full Baxia header set (Version/source/Timezone/
        // bx-*) on every /api/v2 request. Sending only Authorization makes WAF
        // serve a captcha challenge, which navigates the tab and kills the
        // evaluate context. Mirror the UI header set exactly.
        const extraHeaders = loadBaxiaHeaders() || {};
        const result = await page.evaluate(async (data) => {
            try {
                const headers = { ...data.extraHeaders, 'Authorization': `Bearer ${data.token}` };
                headers['X-Request-Id'] = crypto.randomUUID
                    ? crypto.randomUUID()
                    : String(Date.now()) + Math.random().toString(16).slice(2);
                const response = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(data.fileInfo)
                });
                if (response.ok) {
                    const text = await response.text();
                    try { return { success: true, data: JSON.parse(text) }; }
                    catch { return { success: false, status: 200, errorBody: text.slice(0, 200) }; }
                }
                return { success: false, status: response.status, statusText: response.statusText, errorBody: await response.text() };
            } catch (error) { return { success: false, error: error.toString() }; }
        }, { apiUrl: STS_TOKEN_API_URL, token, fileInfo, extraHeaders });

        if (result.success) {
            const body = result.data || {};
            if (body.success === false) {
                throw new Error(`STS token rejected: ${body.data?.code || body.data?.details || 'unknown error'}`);
            }
            // The API wraps credentials in { success, request_id, data: {...} }.
            // uploadFile() expects the inner data object.
            const payload = body.data || body;
            logInfo(`STS token successfully obtained for file: ${fileInfo.filename}`);
            return payload;
        }
        logError(`Error getting STS token: status=${result.status}, error=${result.errorBody || result.error}`);
        throw new Error(`Error getting STS token: ${result.statusText || result.error}`);
    } catch (error) {
        logError(`Error getting STS token: ${error.message}`, error);
        throw error;
    } finally {
        if (page) { try { pagePool.releasePage(page); } catch (e) { logError('Error returning page to pool', e); } }
    }
}

export async function uploadFile(filePath, stsData) {
    const browserContext = validateBrowserContext();
    logInfo(`Starting file upload: ${filePath}`);

    if (!stsData?.file_path || !stsData?.access_key_id || !stsData?.access_key_secret ||
        !stsData?.security_token || !stsData?.region || !stsData?.bucketname) {
        throw new Error('Invalid or incomplete STS token data');
    }

    logInfo(`[OSS] Uploading via browser`);
    logInfo(`[OSS] Region: ${stsData.region}, Bucket: ${stsData.bucketname}`);
    if (stsData.endpoint) logInfo(`[OSS] Endpoint: ${stsData.endpoint}`);

    const fileBuffer = fs.readFileSync(filePath);
    const fileBase64 = fileBuffer.toString('base64');
    logInfo(`[OSS] File size: ${fileBuffer.length} bytes`);

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);
        const result = await page.evaluate(async (data) => {
            try {
                if (typeof window.OSS === 'undefined') {
                    await new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        script.src = data.ossSdkUrl;
                        script.onload = resolve;
                        script.onerror = reject;
                        document.head.appendChild(script);
                    });
                }
                const blob = new Blob([Uint8Array.from(atob(data.fileBase64), c => c.charCodeAt(0))]);
                const client = new window.OSS({
                    region: data.stsData.region,
                    accessKeyId: data.stsData.access_key_id,
                    accessKeySecret: data.stsData.access_key_secret,
                    stsToken: data.stsData.security_token,
                    bucket: data.stsData.bucketname,
                    secure: true
                });
                await client.put(data.stsData.file_path, blob);
                return { success: true };
            } catch (error) { return { success: false, error: error.toString() }; }
        }, {
            fileBase64,
            ossSdkUrl: OSS_SDK_URL,
            stsData: { region: stsData.region, bucketname: stsData.bucketname, file_path: stsData.file_path, access_key_id: stsData.access_key_id, access_key_secret: stsData.access_key_secret, security_token: stsData.security_token }
        });

        if (result.success) {
            return { success: true, fileName: path.basename(filePath), url: stsData.file_url, fileId: stsData.file_id, filePath: stsData.file_path };
        }
        logError(`[OSS] Upload error: ${result.error}`);
        throw new Error(`OSS upload error: ${result.error}`);
    } catch (error) {
        logError(`Error uploading file to OSS: ${error.message}`, error);
        throw error;
    } finally {
        if (page) { try { pagePool.releasePage(page); } catch (e) { logError('Error returning page to pool', e); } }
    }
}

export async function uploadFileToQwen(filePath) {
    try {
        if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

        const fileName = path.basename(filePath);
        const fileSize = fs.statSync(filePath).size;
        const fileExt = path.extname(fileName).toLowerCase();

        let fileType = DEFAULT_FILE_TYPE;
        if (IMAGE_EXTENSIONS.includes(fileExt)) fileType = IMAGE_FILE_TYPE;
        else if (DOCUMENT_EXTENSIONS.includes(fileExt)) fileType = DOCUMENT_FILE_TYPE;

        const fileInfo = { filename: fileName, filesize: fileSize, filetype: fileType };
        const stsData = await getStsToken(fileInfo);
        const uploadResult = await uploadFile(filePath, stsData);
        return { ...uploadResult, fileInfo, stsData };
    } catch (error) {
        logError(`Error during file upload process: ${error.message}`, error);
        return { success: false, error: error.message };
    }
}

export default { getStsToken, uploadFile, uploadFileToQwen };
