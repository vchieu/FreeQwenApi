function render(status) {
    document.getElementById('chat').textContent = status?.capture?.chatId || 'not captured yet';
    const r = status?.lastResult || {};
    document.getElementById('result').textContent = [r.status, r.httpStatus || ''].filter(Boolean).join(' / ') || '—';
}

function refresh() {
    chrome.runtime.sendMessage({ type: 'qwen-sync-status' }).then(render).catch(() => render(null));
}

document.getElementById('sync').addEventListener('click', () => {
    document.getElementById('result').textContent = 'syncing…';
    chrome.runtime.sendMessage({ type: 'qwen-sync-now' })
        .then(() => refresh())
        .catch(() => render(null));
});

refresh();
