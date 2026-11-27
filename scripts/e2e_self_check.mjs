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
    let liveVersionObj = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));

    const srv = http.createServer((req, res) => {
        const rawUrl = req.url || '/';
        const urlPath = decodeURIComponent(rawUrl.split('?')[0]);

        if (urlPath === '/api/health') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, service: 'pea-story-house-e2e' }));
            return;
        }

        if (urlPath === '/api/tts' && req.method === 'POST') {
            let bodyRaw = '';
            req.on('data', (chunk) => { bodyRaw += chunk.toString(); });
            req.on('end', () => {
                const parsed = bodyRaw ? JSON.parse(bodyRaw) : {};
                ttsLog.push({
                    text: String(parsed.text || ''),
                    role: String(parsed.role || 'narrator'),
                    ts: Date.now()
                });
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store'
                });
                res.end(JSON.stringify({ ok: true, role: parsed.role || 'narrator', audioBase64: sampleWavBase64 }));
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
                ttsLog
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
    const { server, port, ttsLog } = await startLocalServer();
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
        await waitFor(`Array.from(document.querySelectorAll('img')).every(i => i.complete && i.naturalWidth > 0)`, 6000, 'cover image load');

        // 标记当前页面实例，后续断言热刷新未重刷整页
        await evalJs(`window.__E2E_PAGE_TOKEN__ = "alive_" + Math.random();`);

        const shelfOverflow = await evalJs(`document.documentElement.scrollWidth <= window.innerWidth`);
        assert.equal(shelfOverflow, true, '分屏书架存在横向溢出');
        await saveScreenshot(cdp, sessionId, '01-split-shelf.png');
        console.log('✓ [590x820] 书架渲染、封面图加载、零横向溢出');

        // 点击书卡进入精装有声绘本模式
        await evalJs(`document.querySelector('.book-card[data-book-id="moon-dessert-shop"]').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().view === 'reader'`, 5000, 'reader view');
        await waitFor(`Array.from(document.querySelectorAll('img')).every(i => i.complete && i.naturalWidth > 0)`, 5000, 'storybook img p1');

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

        await saveScreenshot(cdp, sessionId, '02-split-storybook.png');

        // 绘本 4 页翻页 & 大图全检
        for (let p = 0; p < 4; p++) {
            await waitFor(`window.__PEA_STORY_HOUSE__.getState().pageIndex === ${p}`, 4000, `story page ${p + 1}`);
            await waitFor(`Array.from(document.querySelectorAll('.storybook-illustration')).every(i => i.complete && i.naturalWidth > 0)`, 5000, `story img ${p + 1}`);
            if (p === 0) {
                await evalJs(`window.__PEA_STORY_HOUSE__.audioEngine._ttsMemCache.clear()`);
                ttsLog.length = 0;
                await evalJs(`document.querySelector('.story-para-btn').click()`);
                await waitFor(`window.__PEA_STORY_HOUSE__.audioEngine.lastPlaybackMode === 'neural-mp3'`, 2000, 'story para audio playback');
                assert.ok(ttsLog.some((t) => t.role === 'narrator'), '点击绘本段落应请求 narrator 声线');
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
            }

            // 逐个点击本页角色气泡并记录角色声线
            const bubbleRoles = await evalJs(`Array.from(document.querySelectorAll('.comic-bubble')).map(b => b.getAttribute('data-role'))`);
            for (let bIdx = 0; bIdx < bubbleRoles.length; bIdx++) {
                await evalJs(`window.__PEA_STORY_HOUSE__.audioEngine._ttsMemCache.clear()`);
                ttsLog.length = 0;
                await evalJs(`document.querySelectorAll('.comic-bubble')[${bIdx}].click()`);
                await sleep(220);
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
        await evalJs(`window.__PEA_STORY_HOUSE__.audioEngine._ttsMemCache.clear()`);
        ttsLog.length = 0;
        await evalJs(`document.getElementById('btn-autoplay').click()`);
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().pageIndex === 3`, 8000, 'autoplay advance to page 4');
        await waitFor(`window.__PEA_STORY_HOUSE__.getState().autoplaying === false`, 8000, 'autoplay finish cleanly');
        assert.ok(ttsLog.length >= 6, `全书连播应触发多句连续语音，实际 ${ttsLog.length}`);
        console.log('✓ [590x820] 全书连播跨页与多角色接力通过');

        // 3 秒后台轮询热刷新 + 温柔语音提示校验
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
        assert.ok(ttsLog.some((t) => t.role === 'system_notice'), '热刷新应调用 system_notice 温柔语音提示');
        await saveScreenshot(cdp, sessionId, '04-split-hot-reload.png');
        console.log('✓ [590x820] 3 秒后台轮询原地热刷新与温柔语音播报通过');

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
        console.log('✓ [1180x820] iPad 横屏全屏全视图无溢出通过');

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
