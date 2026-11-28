#!/usr/bin/env node
/**
 * e2e_self_check.mjs - 《🐰 小豌豆魔法故事漫画屋》无头 Chromium 端到端自检脚本
 * 覆盖：iPad 横屏分屏 (590x820) 与全屏 (1180x820)、个人书架、精装绘本模式（左图右文+拼音开关）、
 *       彩色多格漫画模式（分镜+贴纸+多角色气泡 /api/tts 声线）、全书连播、3秒轮询热刷新语音提醒，
 *       严格断言 0 console error / 0 未捕获异常 / 0 404 / 0 裂图 / 0 横向溢出。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARTIFACT_SCRATCH = '/home/better/.gemini/antigravity/brain/85286fe6-81c1-4bb2-b231-86a114511e76/scratch';

const CHROME_CANDIDATES = [
    '/home/better/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
];
const CHROME_BIN = CHROME_CANDIDATES.find((p) => fs.existsSync(p));

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function makeSilentWavBase64(durationSec = 0.1) {
    const sampleRate = 22050;
    const numSamples = Math.max(1024, Math.floor(sampleRate * durationSec));
    const dataSize = numSamples * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    return buf.toString('base64');
}

function startLocalServer() {
    const sampleWavBase64 = makeSilentWavBase64(0.08);
    const ttsLog = [];
    const memWishes = [];
    const memReplies = [];
    const patrolState = {
        enabled: false,
        updatedAt: 0,
        updatedBy: '',
        watcherLastSeenAt: Date.now(),
        watcherOnline: true,
        expiresAt: 0,
        remainingMinutes: 0
    };
    const mailboxLog = { transcribeCalls: 0, wishCalls: 0, replyCalls: 0, patrolPostCalls: 0, dispatchCalls: 0, lastWhisperHints: '' };
    let dispatchRequestedAt = 0;
    let voiceSampleAudioB64 = '';
    let voiceProfile = {
        role: 'pea',
        hasSample: false,
        enabled: false,
        version: 0,
        durationMs: 0,
        sampleText: '',
        sampleMime: 'audio/wav',
        updatedAt: 0,
        updatedStr: '',
        cloneReady: false,
        provider: 'siliconflow',
        providerLabel: '硅基流动 SiliconFlow (CosyVoice2)',
        providerConfigured: true,
        configSource: 'cloud_do',
        apiKeyMasked: 'sk-t...7890',
        providerVoiceSynced: false,
        overrideVoiceConfigured: false,
        lastError: ''
    };
    let liveVersionObj = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));

    const srv = http.createServer((req, res) => {
        const rawUrl = req.url || '/';
        const urlPath = decodeURIComponent(rawUrl.split('?')[0]);

        if (urlPath === '/api/health') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                ok: true,
                service: 'pea-story-house-e2e',
                ai: true,
                mailbox: true,
                voiceClone: { configured: true, provider: 'siliconflow', providerLabel: voiceProfile.providerLabel }
            }));
            return;
        }

        if (urlPath.startsWith('/api/voice-profile')) {
            let bodyRaw = '';
            req.on('data', (chunk) => { bodyRaw += chunk.toString(); });
            req.on('end', () => {
                const body = bodyRaw ? JSON.parse(bodyRaw) : {};
                if (req.method === 'GET' && urlPath === '/api/voice-profile') {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, profile: voiceProfile }));
                    return;
                }
                if (req.method === 'GET' && urlPath === '/api/voice-profile/sample') {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        ok: true,
                        role: 'pea',
                        hasSample: voiceProfile.hasSample,
                        audioBase64: voiceSampleAudioB64,
                        sampleMime: voiceProfile.sampleMime,
                        durationMs: voiceProfile.durationMs,
                        sampleText: voiceProfile.sampleText,
                        version: voiceProfile.version
                    }));
                    return;
                }
                if (req.method === 'POST' && urlPath === '/api/voice-profile') {
                    voiceSampleAudioB64 = String(body.audioBase64 || '');
                    voiceProfile = {
                        ...voiceProfile,
                        hasSample: voiceSampleAudioB64.length >= 2000,
                        enabled: true,
                        version: (voiceProfile.version || 0) + 1,
                        durationMs: Number(body.durationMs) || 8500,
                        sampleText: String(body.sampleText || ''),
                        sampleMime: String(body.sampleMime || 'audio/wav'),
                        updatedAt: Date.now(),
                        updatedStr: '11/28 12:35',
                        providerVoiceSynced: true,
                        cloneReady: voiceSampleAudioB64.length >= 2000
                    };
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, profile: voiceProfile }));
                    return;
                }
                if (req.method === 'POST' && urlPath === '/api/voice-profile/toggle') {
                    voiceProfile = {
                        ...voiceProfile,
                        enabled: Boolean(body.enabled),
                        cloneReady: Boolean(body.enabled) && voiceProfile.hasSample && voiceProfile.providerConfigured
                    };
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, profile: voiceProfile }));
                    return;
                }
                if (req.method === 'POST' && urlPath === '/api/voice-profile/test') {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        ok: true,
                        mode: voiceProfile.cloneReady ? 'cloned' : 'unconfigured',
                        audioBase64: sampleWavBase64,
                        message: voiceProfile.cloneReady ? '已用专属 AI 克隆声线试听！' : '待配置',
                        profile: voiceProfile
                    }));
                    return;
                }
                if (req.method === 'POST' && urlPath === '/api/voice-profile/delete') {
                    voiceSampleAudioB64 = '';
                    voiceProfile = {
                        ...voiceProfile,
                        hasSample: false,
                        enabled: false,
                        providerVoiceSynced: false,
                        cloneReady: false
                    };
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, profile: voiceProfile }));
                    return;
                }
                if (req.method === 'POST' && urlPath === '/api/voice-profile/config') {
                    const keyStr = String(body.apiKey || '').trim();
                    const masked = keyStr ? `${keyStr.slice(0, 4)}...${keyStr.slice(-4)}` : voiceProfile.apiKeyMasked;
                    voiceProfile = {
                        ...voiceProfile,
                        provider: body.provider || voiceProfile.provider,
                        providerConfigured: Boolean(masked),
                        configSource: 'cloud_do',
                        apiKeyMasked: masked
                    };
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, profile: voiceProfile }));
                    return;
                }
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false }));
            });
            return;
        }

        if (urlPath === '/api/tts' && req.method === 'POST') {
            let bodyRaw = '';
            req.on('data', (chunk) => { bodyRaw += chunk.toString(); });
            req.on('end', () => {
                const parsed = bodyRaw ? JSON.parse(bodyRaw) : {};
                const reqRole = String(parsed.role || 'narrator');
                const voiceSource = (reqRole === 'pea' && voiceProfile.cloneReady) ? 'cloned' : 'neural';
                ttsLog.push({
                    text: String(parsed.text || ''),
                    role: reqRole,
                    voiceSource,
                    ts: Date.now()
                });
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'X-Voice-Source': voiceSource
                });
                res.end(JSON.stringify({ ok: true, role: reqRole, voiceSource, audioBase64: sampleWavBase64 }));
            });
            return;
        }

        if (urlPath === '/api/mailbox/transcribe' && req.method === 'POST') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                mailboxLog.transcribeCalls += 1;
                const rawH = req.headers['x-story-hints'];
                if (rawH) {
                    try { mailboxLog.lastWhisperHints = decodeURIComponent(String(rawH)); } catch (_) {}
                }
                const buf = Buffer.concat(chunks);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    ok: buf.length > 20,
                    audioBytes: buf.length,
                    text: '我想让麻薯兔开一架草莓飞机去云朵上找新朋友！',
                    model: '@cf/openai/whisper-large-v3-turbo'
                }));
            });
            return;
        }

        if (urlPath.startsWith('/api/mailbox')) {
            let bodyRaw = '';
            req.on('data', (chunk) => { bodyRaw += chunk.toString(); });
            req.on('end', () => {
                const body = bodyRaw ? JSON.parse(bodyRaw) : {};
                if (req.method === 'POST' && urlPath === '/api/mailbox/wish') {
                    mailboxLog.wishCalls += 1;
                    const replyText = `哇小豌豆！你说的「${String(body.text || '').slice(0, 18)}」太有趣啦，我已经记进云端魔法画本里咯！`;
                    const saved = {
                        ...body,
                        instantReplyKey: 'ai_live',
                        instantReplyText: replyText,
                        status: 'pending'
                    };
                    if (!memWishes.some((w) => w.id === saved.id)) memWishes.push(saved);
                    patrolState.enabled = true;
                    patrolState.updatedAt = Date.now();
                    patrolState.updatedBy = 'auto_wish';
                    patrolState.expiresAt = Date.now() + 60 * 60 * 1000;
                    patrolState.remainingMinutes = 60;
                    dispatchRequestedAt = 0;
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        ok: true,
                        aiGenerated: true,
                        aiModel: '@cf/qwen/qwen3-30b-a3b-fp8',
                        replyKey: 'ai_live',
                        replyText,
                        audioBase64: sampleWavBase64,
                        wishes: memWishes,
                        replies: memReplies,
                        patrol: patrolState
                    }));
                    return;
                }
                if (req.method === 'POST' && urlPath === '/api/mailbox/sync') {
                    for (const w of (body.wishes || [])) {
                        if (w?.id && !memWishes.some((x) => x.id === w.id)) memWishes.push(w);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, wishes: memWishes, replies: memReplies }));
                    return;
                }
                if (req.method === 'POST' && urlPath === '/api/mailbox/reply') {
                    mailboxLog.replyCalls += 1;
                    const replyEntry = {
                        id: body.id || `reply_${Date.now()}`,
                        replyToId: body.replyToId || '',
                        senderName: body.senderName || '魔法故事画师',
                        badgeTitle: body.badgeTitle || '🎉 新故事画好啦！',
                        bookId: body.bookId || '',
                        pageNumber: Number(body.pageNumber || 1),
                        createdAt: body.createdAt || Date.now(),
                        createdStr: body.createdStr || '11/27 17:45',
                        text: body.text || ''
                    };
                    memReplies.push(replyEntry);
                    if (replyEntry.replyToId) {
                        for (const w of memWishes) {
                            if (w.id === replyEntry.replyToId) w.status = 'fulfilled';
                        }
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, wishes: memWishes, replies: memReplies }));
                    return;
                }
                if (urlPath === '/api/mailbox/patrol') {
                    if (req.method === 'POST') {
                        mailboxLog.patrolPostCalls += 1;
                        patrolState.enabled = Boolean(body.enabled);
                        patrolState.updatedAt = Date.now();
                        patrolState.updatedBy = String(body.source || 'web');
                        patrolState.expiresAt = patrolState.enabled ? (Date.now() + 60 * 60 * 1000) : 0;
                        patrolState.remainingMinutes = patrolState.enabled ? 60 : 0;
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: true, patrol: patrolState, serverTime: Date.now() }));
                        return;
                    }
                    const pendingWishes = memWishes.filter((w) => w.status === 'pending');
                    const latestPendingAt = pendingWishes.reduce((mx, w) => Math.max(mx, Number(w.createdAt) || 0), 0);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        ok: true,
                        patrol: patrolState,
                        pendingCount: pendingWishes.length,
                        pendingWishes,
                        latestPendingAt,
                        dispatchRequestedAt,
                        serverTime: Date.now()
                    }));
                    return;
                }
                if (req.method === 'POST' && urlPath === '/api/mailbox/dispatch') {
                    mailboxLog.dispatchCalls += 1;
                    dispatchRequestedAt = Date.now();
                    patrolState.enabled = true;
                    patrolState.updatedAt = dispatchRequestedAt;
                    patrolState.updatedBy = 'user_dispatch';
                    patrolState.expiresAt = dispatchRequestedAt + 60 * 60 * 1000;
                    patrolState.remainingMinutes = 60;
                    const pendingWishes = memWishes.filter((w) => w.status === 'pending');
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        ok: true,
                        patrol: patrolState,
                        dispatchRequestedAt,
                        pendingCount: pendingWishes.length,
                        serverTime: dispatchRequestedAt
                    }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true, wishes: memWishes, replies: memReplies, patrol: patrolState }));
            });
            return;
        }

        if (urlPath === '/__test/bump-version') {
            liveVersionObj = {
                ...liveVersionObj,
                version: '2026.11.27.999',
                updatedAt: new Date().toISOString(),
                latestBookId: 'moon-dessert-shop',
                latestPage: 2,
                changeType: 'new_page',
                summary: '热更新自检：第 2 页魔法刷新',
                silent: false,
                announcement: '小豌豆！你的第 2 页会唱歌的星星布丁已经热更新好啦！'
            };
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, version: liveVersionObj.version }));
            return;
        }

        if (urlPath === '/version.json') {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store, no-cache, must-revalidate'
            });
            res.end(JSON.stringify(liveVersionObj));
            return;
        }

        const safeRel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
        const target = path.resolve(ROOT, safeRel);
        if (!target.startsWith(ROOT + path.sep) && target !== path.join(ROOT, 'index.html')) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        fs.createReadStream(target).pipe(res);
    });

    return new Promise((resolve) => {
        srv.listen(0, '127.0.0.1', () => {
            resolve({
                server: srv,
                port: srv.address().port,
                ttsLog,
                mailboxLog,
                memWishes
            });
        });
    });
}

function launchChrome() {
    assert.ok(CHROME_BIN, '未找到 Chromium 或 Google Chrome 可执行文件');
    return new Promise((resolve, reject) => {
        const proc = spawn(CHROME_BIN, [
            '--headless=new',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--remote-debugging-port=0',
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--window-size=1180,820',
            'about:blank'
        ]);
        let stderr = '';
        const timer = setTimeout(() => {
            try { proc.kill(); } catch (_) {}
            reject(new Error('Chrome launch timeout: ' + stderr));
        }, 12000);
        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (m) {
                clearTimeout(timer);
                resolve({ proc, wsUrl: m[1] });
            }
        });
        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

class CDPClient {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        this.pending = new Map();
        this.onEvent = null;
    }
    connect() {
        return new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = reject;
            this.ws.onmessage = (ev) => {
                const msg = JSON.parse(ev.data);
                if (msg.id && this.pending.has(msg.id)) {
                    const { res, rej } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) rej(new Error(JSON.stringify(msg.error)));
                    else res(msg.result);
                } else if (msg.method && this.onEvent) {
                    this.onEvent(msg);
                }
            };
        });
    }
    send(method, params = {}, sessionId = undefined) {
        const id = ++this.id;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        this.ws.send(JSON.stringify(payload));
        return new Promise((res, rej) => this.pending.set(id, { res, rej }));
    }
    close() {
        try { this.ws.close(); } catch (_) {}
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function saveScreenshot(cdp, sessionId, filename) {
    if (!fs.existsSync(ARTIFACT_SCRATCH)) {
        fs.mkdirSync(ARTIFACT_SCRATCH, { recursive: true });
    }
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const outPath = path.join(ARTIFACT_SCRATCH, filename);
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
    return outPath;
}

async function main() {
    const { server, port, ttsLog, mailboxLog, memWishes } = await startLocalServer();
    const origin = `http://127.0.0.1:${port}`;
    console.log(`🌐 E2E server listening at ${origin}`);

    const { proc, wsUrl } = await launchChrome();
    const cdp = new CDPClient(wsUrl);

    const consoleErrors = [];
    const pageExceptions = [];
    const failedLocalUrls = [];

    try {
        await cdp.connect();
        const { targetInfos } = await cdp.send('Target.getTargets');
        const pageTarget = targetInfos.find((t) => t.type === 'page');
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });

        cdp.onEvent = (msg) => {
            if (msg.method === 'Runtime.exceptionThrown') {
                pageExceptions.push(JSON.stringify(msg.params.exceptionDetails));
            } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
                const text = (msg.params.args || []).map((a) => a.value || a.description || '').join(' ');
                consoleErrors.push(text);
            } else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
                const u = msg.params.response.url;
                if (u.startsWith(origin)) {
                    failedLocalUrls.push(`${msg.params.response.status} ${u}`);
                }
            } else if (msg.method === 'Network.loadingFailed') {
                failedLocalUrls.push(`FAILED ${msg.params.errorText || 'unknown'}`);
            }
        };

        await cdp.send('Page.enable', {}, sessionId);
        await cdp.send('Runtime.enable', {}, sessionId);
        await cdp.send('Network.enable', {}, sessionId);

        const evalJs = async (expression) => {
            const res = await cdp.send('Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise: true
            }, sessionId);
            if (res.exceptionDetails) {
                throw new Error('evalJs exception: ' + JSON.stringify(res.exceptionDetails));
            }
            return res.result ? res.result.value : undefined;
        };

        const waitFor = async (fnExpr, timeoutMs = 6000, label = 'condition') => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const ok = await evalJs(fnExpr);
                if (ok) return ok;
                await sleep(100);
            }
            throw new Error(`Timeout waiting for ${label}: ${fnExpr}`);
        };

        // ============================================================
        // 1. iPad 横屏分屏测试 (590 x 820, DPR 2)
        // ============================================================
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 590,
            height: 820,
            deviceScaleFactor: 2,
            mobile: false
        }, sessionId);

        await cdp.send('Page.navigate', { url: origin }, sessionId);
        await waitFor(`Boolean(document.querySelector('.book-card[data-book-id="moon-dessert-shop"]'))`, 6000, 'bookshelf');
        await waitFor(`Array.from(document.querySelectorAll('.book-cover-img')).every(i => i.complete && i.naturalWidth > 0)`, 6000, 'cover image load');

        // 标记当前页面实例，后续断言热刷新未重刷整页
        await evalJs(`window.__E2E_PAGE_TOKEN__ = "alive_" + Math.random();`);

        const shelfOverflow = await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`);
        assert.equal(shelfOverflow, true, '分屏书架存在横向溢出');
        await saveScreenshot(cdp, sessionId, '01-split-shelf.png');
        console.log('✓ [590x820] 书架渲染、封面图加载、零横向溢出');

        // 验证顶部巡检开关默认关闭并可一键开启
        const initialPressed = await evalJs(`document.getElementById('live-status').getAttribute('aria-pressed')`);
        assert.equal(initialPressed, 'false', '巡检开关应默认关闭');
        await evalJs(`document.getElementById('live-status').click()`);
        await waitFor(`document.getElementById('live-status').getAttribute('aria-pressed') === 'true'`, 3000, 'patrol topbar toggle ON');
        assert.ok(mailboxLog.patrolPostCalls >= 1, '点击顶部开关应请求 POST /api/mailbox/patrol');
        assert.equal(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`), true, '开启巡检后分屏书架存在横向溢出');

        // 测试站内「🪄 聊故事」魔法画师语音/文字对话与云端回信
        await evalJs(`document.getElementById('btn-shelf-open-mailbox').click()`);
        await waitFor(`document.getElementById('storyMailboxOverlay').hidden === false`, 3000, 'open mailbox modal');
        assert.equal(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`), true, '分屏对话弹窗存在横向溢出');

        // 验证弹窗内巡检开关与顶部同步，且可关闭回 OFF
        const modalSwitchOn = await evalJs(`document.getElementById('smPatrolSwitch').getAttribute('aria-checked')`);
        assert.equal(modalSwitchOn, 'true', '弹窗内巡检开关应与顶部同步开启');
        await evalJs(`document.getElementById('smPatrolSwitch').click()`);
        await waitFor(
            `document.getElementById('smPatrolSwitch').getAttribute('aria-checked') === 'false' && document.getElementById('live-status').getAttribute('aria-pressed') === 'false'`,
            3000,
            'patrol modal toggle OFF sync'
        );
        console.log('✓ [590x820] 顶部与弹窗巡检开关联动（默认关 → 顶部开 → 弹窗关）通过');

        // 验证书架弹窗内选书条、目标缩略图卡与角色头像选择
        await waitFor(`Boolean(document.querySelector('.sm-book-pick-btn[data-pick-book="moon-dessert-shop"]'))`, 3000, 'book picker buttons');
        await evalJs(`document.querySelector('.sm-book-pick-btn[data-pick-book="moon-dessert-shop"]').click()`);
        await waitFor(`document.getElementById('smTargetCard').hidden === false && document.querySelectorAll('.sm-char-chip').length >= 3`, 4000, 'target card & char chips');
        await evalJs(`document.querySelector('.sm-char-chip').click()`);
        assert.equal(await evalJs(`document.querySelector('.sm-char-chip').classList.contains('is-active')`), true, '点击角色头像应高亮选中');
        assert.equal(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`), true, '展开选书卡后弹窗存在横向溢出');
        await evalJs(`document.querySelector('.sm-book-pick-btn[data-pick-book=""]').click()`);
        await waitFor(`document.getElementById('smTargetCard').hidden === true && document.getElementById('smCharChipsRow').hidden === true`, 2000, 'switch back to new book');

        // 真实模拟麦克风录音 -> /api/mailbox/transcribe
        await evalJs(`document.getElementById('smMicBtn').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.mailbox.isRecording === true`, 3000, 'mic recording start');
        await sleep(450);
        await evalJs(`document.getElementById('smMicBtn').click()`);
        await waitFor(`document.getElementById('smTextInput').value.includes('草莓飞机')`, 4000, 'whisper transcript');
        assert.ok(mailboxLog.transcribeCalls >= 1, '应当调用 /api/mailbox/transcribe 转写录音');

        // 发送留言 -> /api/mailbox/wish AI 实时回复 + 自动唤醒开启巡检 + 「立刻开工」按钮可用
        await evalJs(`document.getElementById('smSendBtn').click()`);
        await waitFor(
            `window.__PEA_STORY_HOUSE__.mailbox.isSending === false && !document.getElementById('smThinkingRow') && document.querySelectorAll('.sm-from-kid').length >= 1 && document.querySelectorAll('.sm-badge-live').length >= 1`,
            4000,
            'wish & ai reply bubble'
        );
        assert.ok(mailboxLog.wishCalls >= 1, '应当调用 /api/mailbox/wish 发送留言');
        await waitFor(
            `document.getElementById('live-status').getAttribute('aria-pressed') === 'true' && document.getElementById('smPatrolSwitch').getAttribute('aria-checked') === 'true' && document.getElementById('smWakePrompt').hidden === true`,
            3000,
            'wish auto-enables patrol switch'
        );
        assert.equal(await evalJs(`document.getElementById('smDispatchBar').hidden`), false, '发完点子后应显示「说好啦，立刻开工」提示栏');
        await evalJs(`document.getElementById('smDispatchBtn').click()`);
        await waitFor(`document.getElementById('smDispatchBtn').disabled === true && document.getElementById('smDispatchBtn').textContent.includes('已通知开工')`, 3000, 'dispatch now clicked');
        assert.ok(mailboxLog.dispatchCalls >= 1, '点击立刻开工应请求 POST /api/mailbox/dispatch');
        await evalJs(`document.getElementById('smPatrolSwitch').click()`);
        await waitFor(`document.getElementById('live-status').getAttribute('aria-pressed') === 'false'`, 3000, 'restore patrol OFF');
        await saveScreenshot(cdp, sessionId, '07-split-mailbox.png');

        // 注入正式画师回信并验证不打断向上翻看、随后一键跳书页
        const firstWishId = memWishes[0]?.id || '';
        await fetch(`${origin}/api/mailbox/reply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                replyToId: firstWishId,
                bookId: 'moon-dessert-shop',
                pageNumber: 3,
                badgeTitle: '🎉 新故事画好啦！',
                text: '小豌豆，你的草莓飞机点子超棒！快看看第 3 页吧！'
            })
        });
        await evalJs(`(() => { const s = document.getElementById('smStream'); s.scrollTop = 0; })()`);
        await evalJs(`window.__PEA_STORY_HOUSE__.mailbox.syncFromCloud()`);
        await waitFor(`Boolean(document.querySelector('.sm-jump-btn'))`, 4000, 'formal reply jump button');
        await evalJs(`(() => { const s = document.getElementById('smStream'); s.scrollTop = 0; })()`);
        await evalJs(`window.__PEA_STORY_HOUSE__.mailbox.syncFromCloud()`);
        const preservedScrollTop = await evalJs(`document.getElementById('smStream').scrollTop`);
        assert.equal(preservedScrollTop, 0, '无新消息时同步云端不应强制拉回对话流底部');

        await evalJs(`document.querySelector('.sm-jump-btn').click()`);
        await waitFor(`document.getElementById('storyMailboxOverlay').hidden === true && window.__PEA_STORY_HOUSE__.getState().view === 'reader' && window.__PEA_STORY_HOUSE__.getState().pageIndex === 2`, 4000, 'jump to book page 3');
        await evalJs(`document.getElementById('btn-back-shelf').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().view === 'shelf'`, 3000, 'return to shelf');
        console.log('✓ [590x820] 站内语音识别、唤醒提示、防跳底滚动与云端回信直达通过');

        // 测试「🎙️ 我的声音」AI 声线克隆录音室（录音样本上传 + 试听 + 开关 + 缓存签名切换 + 零横向溢出）
        const longMockWav = makeSilentWavBase64(0.15);
        await evalJs(`document.getElementById('btn-open-voice-studio').click()`);
        await waitFor(`document.getElementById('voiceStudioOverlay').hidden === false`, 3000, 'open voice studio');
        assert.equal(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`), true, '分屏我的声音弹窗存在横向溢出');
        await evalJs(`document.querySelector('.vs-prompt-tab[data-prompt-id="sea"]').click()`);
        assert.equal(await evalJs(`document.querySelector('.vs-prompt-tab[data-prompt-id="sea"]').classList.contains('is-active')`), true, '朗读卡片切换应高亮');

        await evalJs(`window.__MOCK_VOICE_STUDIO_WAV__ = { audioBase64: ${JSON.stringify(longMockWav)}, durationMs: 8500 };`);
        await evalJs(`document.getElementById('vsRecBtn').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.voiceStudio.isRecording === true`, 2000, 'voice studio mock record start');
        await evalJs(`document.getElementById('vsRecBtn').click()`);
        await waitFor(`document.getElementById('vsDraftActions').hidden === false`, 2000, 'voice studio mock record stop');

        await evalJs(`document.getElementById('vsSaveBtn').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.voiceStudio.getProfile().cloneReady === true`, 4000, 'save voice clone profile');
        assert.equal(await evalJs(`document.getElementById('vsSavedCard').hidden`), false, '保存后应展示声音档案管理卡片');
        assert.equal(await evalJs(`document.getElementById('voice-studio-dot').classList.contains('is-ready')`), true, '顶部我的声音状态点应点亮绿灯');
        assert.ok(await evalJs(`window.__PEA_STORY_HOUSE__.audioEngine._voiceSig.startsWith('clone-')`), '保存声线后应更新 pea 音频缓存签名');

        await evalJs(`document.getElementById('vsTestCloneBtn').click()`);
        await waitFor(`document.getElementById('vsStatusHint').textContent.includes('试听')`, 4000, 'test cloned voice preview');

        await evalJs(`document.getElementById('vsEnableSwitch').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.voiceStudio.getProfile().cloneReady === false && window.__PEA_STORY_HOUSE__.audioEngine._voiceSig === 'default'`, 3000, 'toggle clone off');
        await evalJs(`document.getElementById('vsEnableSwitch').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.voiceStudio.getProfile().cloneReady === true && window.__PEA_STORY_HOUSE__.audioEngine._voiceSig.startsWith('clone-')`, 3000, 'toggle clone back on');

        await evalJs(`document.getElementById('vsCloseBtn').click()`);
        await waitFor(`document.getElementById('voiceStudioOverlay').hidden === true`, 2000, 'close voice studio');
        const shelfVoiceText = await evalJs(`document.getElementById('btn-shelf-voice-studio')?.textContent || ''`);
        assert.ok(shelfVoiceText.includes('专属声音生效中'), `书架声音按钮应更新为生效状态，实际: ${shelfVoiceText}`);

        // 验证重复点击 sendWish() 防抖、同文本 800ms 播放去重
        const prevWishCount = mailboxLog.wishCalls;
        await evalJs(`(() => {
            const inp = document.getElementById('smTextInput');
            inp.value = '我想去恐龙乐园！';
            window.__PEA_STORY_HOUSE__.mailbox.sendWish();
            window.__PEA_STORY_HOUSE__.mailbox.sendWish();
        })()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.mailbox.isSending === false && document.querySelectorAll('.sm-from-kid').length >= 2`, 4000, 'rapid double sendWish guard');
        assert.equal(mailboxLog.wishCalls, prevWishCount + 1, '连点两次发送只应发出 1 次愿望、播放 1 次回复');

        const dedupeRes = await evalJs(`(async () => {
            window.__PEA_STORY_HOUSE__.audioEngine.stop();
            const p1 = window.__PEA_STORY_HOUSE__.audioEngine.speak('测试防重复语音一句', 'narrator');
            const p2 = await window.__PEA_STORY_HOUSE__.audioEngine.speak('测试防重复语音一句', 'narrator');
            await p1;
            return p2;
        })()`);
        assert.equal(dedupeRes.deduped, true, '同一句语音在播放中短时间内重复触发应被去重拦截');

        // 验证 POST /api/voice-profile/config 仅返回脱敏 apiKeyMasked（绝不回传明文秘钥）
        const cfgResp = await fetch(`${origin}/api/voice-profile/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'siliconflow', apiKey: 'sk-test-secret-1234567890' })
        }).then((r) => r.json());
        assert.equal(cfgResp.ok, true);
        assert.equal(cfgResp.profile.apiKeyMasked, 'sk-t...7890');
        assert.equal(JSON.stringify(cfgResp).includes('1234567890'), false, '配置接口不得明文回传 API Key');
        console.log('✓ [590x820] 「我的声音」录音棚、声线克隆状态与防重复播放机制通过');

        // 验证文字主导型积累本（《小豌豆的中国好文章积累本》：好词宝石盒 + 佳句摘抄栏 + 小配图放大）
        await evalJs(`document.querySelector('.book-card[data-book-id="chinese-reading-notebook"]').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().view === 'reader' && Boolean(document.querySelector('.notebook-sheet'))`, 4000, 'open chinese-reading-notebook');
        assert.equal(await evalJs(`document.getElementById('btn-mode-storybook').textContent.trim()`), '📝 积累本', '积累本左上模式按钮应显示为积累本');
        assert.equal(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`), true, '分屏文字积累本存在横向溢出');

        await evalJs(`window.__PEA_STORY_HOUSE__.audioEngine.clearCache()`);
        ttsLog.length = 0;
        await evalJs(`document.querySelector('.word-gem-card').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.audioEngine.lastPlaybackMode === 'neural-mp3'`, 3000, 'notebook word gem speak');
        assert.ok(ttsLog.some((t) => t.text.includes('好词：')), '点击好词卡片应朗读词语与释义');

        await evalJs(`window.__PEA_STORY_HOUSE__.audioEngine.clearCache()`);
        ttsLog.length = 0;
        await evalJs(`document.querySelector('.sentence-quote-card').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.audioEngine.lastPlaybackMode === 'neural-mp3'`, 3000, 'notebook sentence quote speak');
        assert.ok(ttsLog.length >= 1, '点击佳句摘抄卡应触发朗读');

        await evalJs(`document.querySelector('.notebook-thumb-btn').click()`);
        await waitFor(`document.getElementById('art-lightbox').hidden === false && document.getElementById('art-lightbox-img').complete`, 3000, 'notebook thumb zoom');
        await evalJs(`document.getElementById('btn-lightbox-close').click()`);
        await waitFor(`document.getElementById('art-lightbox').hidden === true`, 2000, 'close notebook lightbox');
        await saveScreenshot(cdp, sessionId, '08-split-notebook.png');
        await evalJs(`document.getElementById('btn-back-shelf').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().view === 'shelf'`, 3000, 'return from notebook to shelf');
        console.log('✓ [590x820] 文字主导积累本排版（好词宝石盒、佳句摘抄栏、零横向溢出）通过');

        // 验证书架上显示阅读进度，点开续读第 3 页，再切换到第 1 页做全页自检
        const shelfProgressText = await evalJs(`document.querySelector('.book-card[data-book-id="moon-dessert-shop"] .progress-pill')?.textContent || ''`);
        assert.ok(shelfProgressText.includes('第 3 页'), `书架卡片应显示阅读进度，实际: ${shelfProgressText}`);
        await evalJs(`document.querySelector('.book-card[data-book-id="moon-dessert-shop"]').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().view === 'reader' && window.__PEA_STORY_HOUSE__.getState().pageIndex === 2`, 5000, 'resume reader at page 3');
        await evalJs(`document.querySelector('.page-dot[data-page-idx="0"]').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().pageIndex === 0`, 4000, 'storybook reset to p1');
        await waitFor(`Array.from(document.querySelectorAll('.storybook-illustration')).every(i => i.complete && i.naturalWidth > 0)`, 5000, 'storybook img p1');

        const spreadGeometry = await evalJs(`(() => {
            const left = document.querySelector('.storybook-left-page').getBoundingClientRect();
            const right = document.querySelector('.storybook-right-page').getBoundingClientRect();
            return { leftRight: left.right, rightLeft: right.left, noOverflow: document.documentElement.scrollWidth <= window.innerWidth };
        })()`);
        assert.equal(spreadGeometry.noOverflow, true, '分屏绘本模式存在横向溢出');
        assert.ok(spreadGeometry.leftRight <= spreadGeometry.rightLeft + 24, `分屏绘本应保持左图右文并排: left.right=${spreadGeometry.leftRight}, right.left=${spreadGeometry.rightLeft}`);

        // 拼音开关切换校验
        const rtBefore = await evalJs(`getComputedStyle(document.querySelector('rt.py-rt')).display`);
        assert.notEqual(rtBefore, 'none', '初始拼音应当显示');
        await evalJs(`document.getElementById('btn-toggle-pinyin').click()`);
        const rtOff = await evalJs(`getComputedStyle(document.querySelector('rt.py-rt')).display`);
        assert.equal(rtOff, 'none', '关闭拼音后 <rt> 应当隐藏');
        await evalJs(`document.getElementById('btn-toggle-pinyin').click()`);
        const rtOnAgain = await evalJs(`getComputedStyle(document.querySelector('rt.py-rt')).display`);
        assert.notEqual(rtOnAgain, 'none', '重新打开拼音后 <rt> 应当显示');

        // 语速切换（慢读 0.85 <-> 常速 1.0）
        assert.equal(await evalJs(`window.__PEA_STORY_HOUSE__.getState().slowMode`), false, '初始应为常速模式');
        await evalJs(`document.getElementById('btn-speed').click()`);
        assert.equal(await evalJs(`window.__PEA_STORY_HOUSE__.getState().slowMode`), true, '点击慢读按钮应切换为慢读模式');
        assert.equal(await evalJs(`window.__PEA_STORY_HOUSE__.audioEngine.playbackRate`), 0.85, '慢读语速应为 0.85');
        await evalJs(`document.getElementById('btn-speed').click()`);
        assert.equal(await evalJs(`window.__PEA_STORY_HOUSE__.getState().slowMode`), false, '再次点击应恢复常速');

        // 测试绘本「✏️ 改这一页」直达弹窗并自动带入当前书页锚点
        await evalJs(`document.getElementById('btn-edit-storybook-page').click()`);
        await waitFor(
            `document.getElementById('storyMailboxOverlay').hidden === false && document.getElementById('smTargetCard').hidden === false && window.__PEA_STORY_HOUSE__.mailbox.editTarget.bookId === 'moon-dessert-shop' && window.__PEA_STORY_HOUSE__.mailbox.editTarget.pageNumber === 1`,
            3000,
            'storybook edit page target'
        );
        await evalJs(`document.getElementById('smCloseBtn').click()`);
        await waitFor(`document.getElementById('storyMailboxOverlay').hidden === true`, 2000, 'close storybook edit modal');

        await saveScreenshot(cdp, sessionId, '02-split-storybook.png');

        // 绘本 4 页翻页 & 大图全检
        for (let p = 0; p < 4; p++) {
            await waitFor(`window.__PEA_STORY_HOUSE__.getState().pageIndex === ${p}`, 4000, `story page ${p + 1}`);
            await waitFor(`Array.from(document.querySelectorAll('.storybook-illustration')).every(i => i.complete && i.naturalWidth > 0)`, 5000, `story img ${p + 1}`);
            if (p === 0) {
                await evalJs(`window.__PEA_STORY_HOUSE__.audioEngine.clearCache()`);
                ttsLog.length = 0;
                await evalJs(`document.querySelector('.story-para-btn').click()`);
                await waitFor(`window.__PEA_STORY_HOUSE__.audioEngine.lastPlaybackMode === 'neural-mp3'`, 3000, 'story para audio playback');
                assert.ok(ttsLog.some((t) => t.role === 'narrator'), '点击绘本段落应请求 narrator 声线');

                // 验证仅清空内存缓存后，同一句再次点击可直接命中浏览器 CacheStorage 持久缓存而不重复请求后端
                await sleep(120);
                await evalJs(`window.__PEA_STORY_HOUSE__.audioEngine._ttsMemCache.clear()`);
                ttsLog.length = 0;
                await evalJs(`document.querySelector('.story-para-btn').click()`);
                await waitFor(`window.__PEA_STORY_HOUSE__.audioEngine.lastPlaybackMode === 'neural-mp3'`, 3000, 'story para disk cache playback');
                assert.equal(ttsLog.length, 0, '命中浏览器 CacheStorage 持久缓存后不应再请求 /api/tts');
            }
            if (p < 3) {
                await evalJs(`document.getElementById('btn-next-page').click()`);
            }
        }
        console.log('✓ [590x820] 精装有声绘本模式（左图右文、4页大图、拼音开关、旁白发声）');

        // 切换至彩色多格漫画模式
        await evalJs(`document.getElementById('btn-mode-comic').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().mode === 'comic'`, 4000, 'comic mode');
        // 跳回第 1 页检查全 4 页
        await evalJs(`document.querySelector('.page-dot[data-page-idx="0"]').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().pageIndex === 0`, 4000, 'comic p1');

        const seenComicRoles = new Set();
        for (let p = 0; p < 4; p++) {
            await waitFor(`window.__PEA_STORY_HOUSE__.getState().pageIndex === ${p}`, 4000, `comic page ${p + 1}`);
            await waitFor(`Array.from(document.querySelectorAll('.comic-panel-img')).every(i => i.complete && i.naturalWidth > 0)`, 5000, `comic imgs p${p + 1}`);
            const check = await evalJs(`({
                panelCount: document.querySelectorAll('.comic-panel').length,
                stickerCount: document.querySelectorAll('.comic-sticker').length,
                noOverflow: document.documentElement.scrollWidth <= window.innerWidth
            })`);
            assert.equal(check.noOverflow, true, `分屏漫画第 ${p + 1} 页存在横向溢出`);
            assert.ok(check.panelCount >= 3, `分屏漫画第 ${p + 1} 页分镜数不足`);
            assert.ok(check.stickerCount >= 3, `分屏漫画第 ${p + 1} 页贴纸数不足`);

            if (p === 0) {
                await saveScreenshot(cdp, sessionId, '03-split-comic-p1.png');
                // 测试漫画分镜「✏️ 改这格」直达第 2 格精准锚点
                assert.ok(await evalJs(`document.querySelectorAll('.btn-edit-panel').length >= 3`), '每个漫画面板都应有改这格按钮');
                await evalJs(`document.querySelectorAll('.btn-edit-panel')[1].click()`);
                await waitFor(
                    `document.getElementById('storyMailboxOverlay').hidden === false && window.__PEA_STORY_HOUSE__.mailbox.editTarget.panelNumber === 2 && document.getElementById('smTargetCard').textContent.includes('第 2 格')`,
                    3000,
                    'comic panel 2 edit target'
                );
                await evalJs(`document.getElementById('smCloseBtn').click()`);
                await waitFor(`document.getElementById('storyMailboxOverlay').hidden === true`, 2000, 'close comic edit modal');

                // 测试漫画插画点击放大看细节
                await evalJs(`document.querySelector('.comic-art-zoom-btn').click()`);
                await waitFor(`document.getElementById('art-lightbox').hidden === false && document.getElementById('art-lightbox-img').complete && document.getElementById('art-lightbox-img').naturalWidth > 0`, 3000, 'open comic lightbox');
                await evalJs(`document.getElementById('btn-lightbox-close').click()`);
                await waitFor(`document.getElementById('art-lightbox').hidden === true`, 2000, 'close comic lightbox');
            }

            // 逐个点击本页角色气泡并记录角色声线
            const bubbleRoles = await evalJs(`Array.from(document.querySelectorAll('.comic-bubble')).map(b => b.getAttribute('data-role'))`);
            for (let bIdx = 0; bIdx < bubbleRoles.length; bIdx++) {
                await evalJs(`window.__PEA_STORY_HOUSE__.audioEngine.clearCache()`);
                ttsLog.length = 0;
                await evalJs(`document.querySelectorAll('.comic-bubble')[${bIdx}].click()`);
                await waitFor(
                    `window.__PEA_STORY_HOUSE__.audioEngine.lastPlaybackMode === 'neural-mp3'`,
                    3000,
                    `comic bubble p${p + 1} b${bIdx}`
                );
                const expectedRole = bubbleRoles[bIdx];
                assert.ok(ttsLog.some((t) => t.role === expectedRole), `第 ${p + 1} 页气泡 ${bIdx} 应请求角色声线 ${expectedRole}`);
                seenComicRoles.add(expectedRole);
            }

            if (p < 3) {
                await evalJs(`document.getElementById('btn-next-page').click()`);
            }
        }
        for (const r of ['pea', 'bunny', 'bear', 'star_boy']) {
            assert.ok(seenComicRoles.has(r), `缺少漫画角色声线验证: ${r}`);
        }
        console.log('✓ [590x820] 彩色多格漫画模式（12格全彩图、拟声词贴纸、4种角色气泡声线）');

        // 全书连播测试（从第 3 页连播跨到第 4 页并自动收尾）
        await evalJs(`document.querySelector('.page-dot[data-page-idx="2"]').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().pageIndex === 2`, 4000, 'goto page 3 for autoplay');
        await evalJs(`window.__PEA_STORY_HOUSE__.audioEngine.clearCache()`);
        ttsLog.length = 0;
        await evalJs(`document.getElementById('btn-autoplay').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().pageIndex === 3`, 8000, 'autoplay advance to page 4');
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().autoplaying === false`, 8000, 'autoplay finish cleanly');
        assert.ok(ttsLog.length >= 6, `全书连播应触发多句连续语音，实际 ${ttsLog.length}`);
        console.log('✓ [590x820] 全书连播跨页与多角色接力通过');

        // 3 秒后台轮询热刷新 + 温柔语音提示校验（以及同书正式回信不重复播报校验）
        const secondWishId = memWishes[1]?.id || '';
        await fetch(`${origin}/api/mailbox/reply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                replyToId: secondWishId,
                bookId: 'moon-dessert-shop',
                pageNumber: 2,
                badgeTitle: '🎉 第2页热更新画好啦！',
                text: '小豌豆，第 2 页会唱歌的星星布丁已经画好啦！'
            })
        });
        ttsLog.length = 0;
        const prevToken = await evalJs(`window.__E2E_PAGE_TOKEN__`);
        await fetch(`${origin}/__test/bump-version`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().hotReloadCount >= 1`, 5500, '3s polling hot reload');
        await sleep(300);

        const afterReload = await evalJs(`({
            token: window.__E2E_PAGE_TOKEN__,
            bannerHidden: document.getElementById('hot-reload-banner').hidden,
            pageIndex: window.__PEA_STORY_HOUSE__.getState().pageIndex,
            version: window.__PEA_STORY_HOUSE__.getState().version
        })`);
        assert.equal(afterReload.token, prevToken, '热刷新不得整页 reload');
        assert.equal(afterReload.bannerHidden, false, '热刷新提示横幅应当显示');
        assert.equal(afterReload.version, '2026.11.27.999', '版本应更新为新版本号');
        assert.equal(afterReload.pageIndex, 1, '热刷新应自动跳转至新更新的页码');
        assert.equal(ttsLog.filter((t) => t.role === 'system_notice').length, 1, '热刷新只应播放 1 次 system_notice 温柔语音提示');
        await saveScreenshot(cdp, sessionId, '04-split-hot-reload.png');

        ttsLog.length = 0;
        await evalJs(`document.getElementById('btn-open-mailbox').click()`);
        await waitFor(`document.getElementById('storyMailboxOverlay').hidden === false`, 3000, 'open mailbox after hot reload');
        await sleep(250);
        assert.equal(ttsLog.length, 0, '刚听过版本更新播报后立刻打开聊天窗，不应再次自动重复播报同一封正式回信');
        await evalJs(`document.getElementById('smCloseBtn').click()`);
        await waitFor(`document.getElementById('storyMailboxOverlay').hidden === true`, 2000, 'close mailbox after dedupe check');
        console.log('✓ [590x820] 3 秒后台轮询原地热刷新与单次播报去重通过');

        // ============================================================
        // 2. iPad 横屏全屏测试 (1180 x 820, DPR 2)
        // ============================================================
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 1180,
            height: 820,
            deviceScaleFactor: 2,
            mobile: false
        }, sessionId);

        await evalJs(`document.getElementById('btn-mode-storybook').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().mode === 'storybook'`, 4000, 'full storybook');
        assert.equal(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`), true, '全屏绘本存在横向溢出');
        await saveScreenshot(cdp, sessionId, '05-full-storybook.png');

        await evalJs(`document.getElementById('btn-mode-comic').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().mode === 'comic'`, 4000, 'full comic');
        await waitFor(`Array.from(document.querySelectorAll('.comic-panel-img')).every(i => i.complete && i.naturalWidth > 0)`, 4000, 'full comic imgs');
        assert.equal(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`), true, '全屏漫画存在横向溢出');
        await saveScreenshot(cdp, sessionId, '06-full-comic.png');

        await evalJs(`document.getElementById('btn-back-shelf').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().view === 'shelf'`, 4000, 'full shelf');
        assert.equal(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`), true, '全屏书架存在横向溢出');

        await evalJs(`document.getElementById('btn-open-voice-studio').click()`);
        await waitFor(`document.getElementById('voiceStudioOverlay').hidden === false`, 3000, 'full voice studio open');
        assert.equal(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`), true, '全屏我的声音弹窗存在横向溢出');
        await evalJs(`document.getElementById('vsCloseBtn').click()`);
        await waitFor(`document.getElementById('voiceStudioOverlay').hidden === true`, 2000, 'full voice studio close');

        // 验证书架显示第 2 页进度，且再次点开直接续读第 2 页和偏好的漫画模式
        const p2Badge = await evalJs(`document.querySelector('.book-card[data-book-id="moon-dessert-shop"] .progress-pill')?.textContent || ''`);
        assert.ok(p2Badge.includes('第 2 页'), `返回书架应显示第 2 页阅读进度，实际: ${p2Badge}`);
        await evalJs(`document.querySelector('.book-card[data-book-id="moon-dessert-shop"]').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().view === 'reader' && window.__PEA_STORY_HOUSE__.getState().pageIndex === 1 && window.__PEA_STORY_HOUSE__.getState().mode === 'comic'`, 4000, 'resume page 2 in comic mode');
        await evalJs(`document.getElementById('btn-back-shelf').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().view === 'shelf'`, 3000, 'back to shelf final');

        await evalJs(`document.querySelector('.book-card[data-book-id="chinese-reading-notebook"]').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().view === 'reader' && Boolean(document.querySelector('.notebook-sheet'))`, 4000, 'full open chinese-reading-notebook');
        assert.equal(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`), true, '全屏文字积累本存在横向溢出');
        await saveScreenshot(cdp, sessionId, '09-full-notebook.png');
        await evalJs(`document.getElementById('btn-back-shelf').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().view === 'shelf'`, 3000, 'back to shelf after notebook');

        console.log('✓ [1180x820] iPad 横屏全屏全视图、积累本排版、续读进度与模式偏好通过');

        assert.deepEqual(consoleErrors, [], `Console errors detected: ${consoleErrors.join('; ')}`);
        assert.deepEqual(pageExceptions, [], `Page exceptions detected: ${pageExceptions.join('; ')}`);
        assert.deepEqual(failedLocalUrls, [], `Failed local requests detected: ${failedLocalUrls.join('; ')}`);

        console.log('🎉 E2E self-check PASSED with 0 console errors, 0 page exceptions, and 0 failed requests!');
    } finally {
        cdp.close();
        try { proc.kill('SIGKILL'); } catch (_) {}
        server.close();
    }
}

main().catch((err) => {
    console.error('❌ E2E self-check FAILED:', err);
    process.exit(1);
});
