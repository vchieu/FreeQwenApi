import { spawn } from 'node:child_process';

/**
 * Pure command builder: lets offline tests verify every platform without
 * actually spawning a notification.
 */
export function notificationCommand(platform, title, message) {
    const safeTitle = String(title || 'FreeQwenApi').replace(/[\r\n"'\\]/g, ' ').slice(0, 80);
    const safeMessage = String(message || 'FreeQwenApi needs your attention').replace(/[\r\n"'\\]/g, ' ').slice(0, 300);

    if (platform === 'win32') {
        const script = `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('${safeMessage}', '${safeTitle}', 'OK', 'Warning')`;
        // No `-NonInteractive`: it suppresses WinForms UI in some sessions.
        return { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', script] };
    }
    if (platform === 'darwin') {
        return {
            cmd: 'osascript',
            args: ['-e', `display notification "${safeMessage}" with title "${safeTitle}" sound name "Ping"`]
        };
    }
    if (platform === 'linux') {
        return { cmd: 'notify-send', args: [safeTitle, safeMessage] };
    }
    return null;
}

/**
 * Fire-and-forget desktop alert. Never throws: losing a notification must not
 * fail a chat request. Set QWEN_CAPTCHA_NOTIFY=off to disable.
 */
export function sendDesktopNotification(title, message) {
    if (String(process.env.QWEN_CAPTCHA_NOTIFY || '').toLowerCase() === 'off') return false;
    const spec = notificationCommand(process.platform, title, message);
    if (!spec) return false;
    try {
        // On Windows, `detached: true` makes WinForms MessageBox return
        // immediately with no visible UI. Keep the child attached (but unref'd)
        // so the popup actually shows while the proxy keeps running.
        const child = spawn(spec.cmd, spec.args, {
            stdio: 'ignore',
            windowsHide: false
        });
        child.on('error', () => { /* notification is best-effort */ });
        child.unref();
        return true;
    } catch {
        return false;
    }
}
