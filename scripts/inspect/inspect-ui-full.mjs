import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync('session/ui-full-capture.json', 'utf8'));
for (const r of data) {
    console.log('URL:', r.url);
    console.log('RESPONSE LENGTH:', r.responseBody?.length);
    console.log('RESPONSE HEAD:', String(r.responseBody).slice(0, 600));
    if (r.url.includes('completions')) {
        console.log('\n--- SSE CHUNKS ---');
        for (const line of String(r.responseBody).split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const raw = line.replace(/^data:\s*/, '').trim();
            if (!raw || raw === '[DONE]') continue;
            try {
                const j = JSON.parse(raw);
                const d = j.choices?.[0]?.delta;
                console.log(JSON.stringify({
                    phase: d?.phase,
                    status: d?.status,
                    role: d?.role,
                    content: d?.content,
                    contentType: typeof d?.content,
                    keys: d ? Object.keys(d) : null,
                    finish: j.choices?.[0]?.finish_reason
                }));
            } catch { console.log('RAW:', raw.slice(0, 200)); }
        }
    }
}
