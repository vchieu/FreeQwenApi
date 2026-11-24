import { getBrowserContext } from '../browser/browser.js';
import { logInfo, logError } from '../logger/index.js';
import { getAuthToken, extractAuthToken, pagePool, loadBaxiaHeaders } from './chat.js';
import { getAvailableToken, decodeTokenInfo } from './tokenManager.js';
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
    'image/bmp': '.bmp'
};
const EXTENSION_MIMES = Object.fromEntries(
    Object.entries(MIME_EXTENSIONS).map(([mime, ext]) => [ext, mime])
);
const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/;

function extFromMime(mime) {
    return MIME_EXTENSIONS[String(mime || '').toLowerCase()] || '.png';
}

function mimeFromUrl(url) {
    try {
        return EXTENSION_MIMES[path.extname(new URL(url).pathname).toLowerCase()] || null;
    } catch {
        return null;
    }
}

function imageSourceFromPart(part) {
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'image_url') {
        if (typeof part.image_url === 'string') return part.image_url;
        return part.image_url?.url || null;
    }
    if (part.type === 'image') {
        const source = part.image || part.url || part.file;
        return typeof source === 'string' ? source : null;
    }
    return null;
}

async function imageSourceToBuffer(source) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('Empty image source');

    if (source.startsWith('data:')) {
        const match = source.match(DATA_URL_RE);
        if (!match) throw new Error('Invalid image data URL');
        const mime = (match[1] || 'image/png').toLowerCase();
        const buffer = match[2]
            ? Buffer.from(match[3], 'base64')
            : Buffer.from(decodeURIComponent(match[3]), 'utf8');
        if (!buffer.length) throw new Error('Empty image data');
        return { buffer, mime, ext: extFromMime(mime), lastModified: Date.now() };
    }

    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to download image: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Empty image data');
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
        || mimeFromUrl(source)
        || 'image/png';
    return { buffer, mime, ext: extFromMime(mime), lastModified: Date.now() };
}

function buildQwenImageFile(stsData, uploadResult, { filename, size, mime, lastModified }) {
    const id = stsData.file_id || uploadResult.fileId;
    const now = Date.now();
    const browserToken = getAuthToken();
    const userId = browserToken ? decodeTokenInfo(browserToken).accountId : null;

    // Mirror the shape the real Qwen UI sends in messages[].files so the web
    // backend recognises the image as an uploaded vision attachment.
    return {
        type: 'image',
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
        showType: 'image',
        file_class: 'vision',
        uploadTaskId: crypto.randomUUID()
    };
}

async function uploadImageSource(source) {
    const { buffer, mime, ext, lastModified } = await imageSourceToBuffer(source);
    const filename = `image-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
    const tempDir = path.resolve(process.cwd(), UPLOADS_DIR);
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${crypto.randomUUID()}${ext}`);
    try {
        fs.writeFileSync(tempPath, buffer);
        logInfo(`[image] Uploading ${filename} (${buffer.length} bytes, ${mime})`);
        const stsData = await getStsToken({ filename, filesize: String(buffer.length), filetype: 'image' });
        const uploaded = await uploadFile(tempPath, stsData);
        return buildQwenImageFile(stsData, uploaded, { filename, size: buffer.length, mime, lastModified });
    } finally {
        try { fs.unlinkSync(tempPath); } catch { /* already removed */ }
    }
}

// Qwen Web accepts a plain string for messages[].content. OpenAI clients send
// arrays of parts; once images are moved into files[] we collapse what remains
// back into a string so the payload matches a real UI request.
function collapseImageMessageContent(content) {
    if (!Array.isArray(content)) return content;
    const chunks = [];
    for (const part of content) {
        if (!part) continue;
        if (typeof part === 'string') {
            chunks.push(part);
        } else if (part.type === 'text') {
            chunks.push(part.text || '');
        } else {
            // Preserve any uncommon non-image part in a readable text form.
            const value = part.url || part.file || part.name || '';
            chunks.push(`[${part.type}: ${value}]`);
        }
    }
    return chunks.filter(Boolean).join('\n');
}

// Pure selection step: only the CURRENT (last) user turn is uploaded. Earlier
// turns already live in Qwen's server-side chat history, so re-uploading them
// would attach every old image again on each follow-up request. Older image
// parts become short placeholders so stale data URLs never reach a prompt.
export function collectImageParts(messages) {
    const result = { currentParts: [], touchedMessages: new Set(), currentMessage: null };
    if (!Array.isArray(messages)) return result;

    const userMessages = messages.filter(msg => msg && msg.role === 'user');
    if (!userMessages.length) return result;
    const currentMessage = userMessages[userMessages.length - 1];
    result.currentMessage = currentMessage;

    const seenSources = new Set();
    for (const msg of userMessages) {
        if (!Array.isArray(msg.content)) continue;
        // Snapshot - msg.content is mutated while image parts are stripped.
        for (const part of [...msg.content]) {
            const source = imageSourceFromPart(part);
            if (!source) continue;
            result.touchedMessages.add(msg);

            const replace = (text) => {
                const index = msg.content.indexOf(part);
                if (index !== -1) msg.content.splice(index, 1, { type: 'text', text });
            };

            if (msg !== currentMessage) {
                replace('[image]');
                continue;
            }
            if (seenSources.has(source)) {
                // Some clients duplicate the same part; upload it only once.
                const index = msg.content.indexOf(part);
                if (index !== -1) msg.content.splice(index, 1);
                continue;
            }
            seenSources.add(source);
            result.currentParts.push({ msg, part, source });
        }
    }
    return result;
}

// Converts OpenAI `image_url` / internal `image` parts into Qwen OSS
// attachments, then strips them from content - Qwen expects images in
// messages[].files, not inside messages[].content.
export async function prepareOpenAIImages(messages) {
    if (!Array.isArray(messages)) return { files: [], error: null };

    const { currentParts, touchedMessages, currentMessage } = collectImageParts(messages);
    if (!touchedMessages.size) return { files: [], error: null };

    const files = [];
    const errors = [];
    for (const { msg, part, source } of currentParts) {
        try {
            files.push(await uploadImageSource(source));
            const index = msg.content.indexOf(part);
            if (index !== -1) msg.content.splice(index, 1);
        } catch (error) {
            logError(`[image] Failed to upload image: ${error.message}`);
            errors.push(error.message);
            const index = msg.content.indexOf(part);
            if (index !== -1) msg.content.splice(index, 1, { type: 'text', text: '[image upload failed]' });
        }
    }

    // Collapse only messages we changed, after every image part was removed.
    for (const msg of touchedMessages) {
        msg.content = collapseImageMessageContent(msg.content);
    }

    if (!files.length && errors.length) {
        return { files: [], error: `Image upload failed: ${errors[0]}` };
    }
    // A text-less image message still needs a prompt for Qwen to answer.
    for (const msg of touchedMessages) {
        if (!String(msg.content || '').trim()) {
            msg.content = msg === currentMessage
                ? 'Please describe the attached image.'
                : '[image]';
        }
    }
    return { files, error: null };
}

function validateBrowserContext() {
    const browserContext = getBrowserContext();
    if (!browserContext) throw new Error('Browser is not initialized');
    return browserContext;
}

async function validateAuthToken(browserContext) {
    const tokenObj = await getAvailableToken();
    if (tokenObj?.token) {
        logInfo(`Using token from tokenManager: ${tokenObj.id}`);
        return tokenObj.token;
    }

    let token = getAuthToken();
    if (!token) {
        logInfo('Auth token not found in memory, trying to extract from browser');
        token = await extractAuthToken(browserContext);
        if (!token) throw new Error('Failed to get auth token');
    }
    return token;
}

export async function getStsToken(fileInfo) {
    const browserContext = validateBrowserContext();
    const token = await validateAuthToken(browserContext);
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
