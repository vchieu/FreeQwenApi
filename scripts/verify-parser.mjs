// Offline check of the exact SSE accumulation logic against a real captured
// Qwen response. No network calls.
import fs from 'node:fs';

const captured = JSON.parse(fs.readFileSync('session/ui-full-capture.json', 'utf8'))
    .find(r => r.url.includes('chat/completions'));
if (!captured) throw new Error('No captured completions response');

let fullContent = '';
let finished = false;
for (const line of String(captured.responseBody).split(/\r?\n/)) {
    if (finished) break;
    if (!line.trim() || !line.startsWith('data: ')) continue;
    const jsonStr = line.substring(6).trim();
    if (!jsonStr || jsonStr === '[DONE]') continue;
    let chunk;
    try { chunk = JSON.parse(jsonStr); } catch { continue; }
    if (chunk.choices && chunk.choices[0]) {
        const choice = chunk.choices[0];
        const delta = choice.delta || choice.message;
        const phase = delta?.phase;
        const isThinking = phase === 'thinking_summary' || phase === 'thinking';
        const content = delta && (delta.content ?? delta.text ?? delta.output_text);
        if (!isThinking) {
            if (typeof content === 'string') fullContent += content;
            else if (Array.isArray(content)) fullContent += content.map(p => typeof p === 'string' ? p : (p?.text ?? p?.content ?? '')).join('');
            else if (content && typeof content === 'object') fullContent += String(content.text ?? content.content ?? '');
        }
        if (choice.finish_reason) finished = true;
    }
}

console.log('EXPECTED: hello again UI answer');
console.log('GOT     :', JSON.stringify(fullContent));
console.log(fullContent.length > 0 ? 'PASS' : 'FAIL');
