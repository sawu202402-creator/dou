#!/usr/bin/env node
/**
 * scripts/watch_mailbox.mjs - 零 Token 本地云端信箱哨兵脚本
 *
 * 作用：
 * - 在本地安静轮询 `${baseUrl}/api/mailbox/patrol?watcher=1`，平时 0 AI Token 消耗；
 * - 网页端巡检开关关闭时保持低频（默认 25 秒）；开启时自动加速（默认 8 秒）；
 * - 只有当「网页端巡检开关为开启」且「存在待处理的 pending 留言」时，打印新留言摘要并以退出码 0 退出，
 *   从而自动唤醒 Antigravity 按 GEMINI.md 的 5 步流水线开始画新书！
 *
 * 用法：
 *   node scripts/watch_mailbox.mjs [--url https://...] [--idle-sec 25] [--active-sec 8] [--debounce-sec 40] [--once]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, '.mailbox-config.json');

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (_) {}
    return { baseUrl: '' };
}

function normalizeUrl(u) {
    if (!u) return '';
    let s = String(u).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s;
}

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                out[key] = next;
                i++;
            } else {
                out[key] = true;
            }
        } else {
            out._.push(a);
        }
    }
    return out;
}

function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollOnce(baseUrl) {
    const res = await fetch(`${baseUrl}/api/mailbox/patrol?watcher=1`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
    }
    const data = await res.json();
    if (!data || !data.ok) {
        throw new Error(data?.error || 'invalid_patrol_payload');
    }
    return data;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cfg = loadConfig();
    const baseUrl = normalizeUrl(args.url || process.env.MAILBOX_URL || cfg.baseUrl);
    if (!baseUrl) {
        console.error('❌ 尚未配置线上故事屋网址！请先运行：node scripts/mailbox_cli.mjs set-url https://<你的线上网址>');
        process.exit(1);
    }

    const idleSec = Math.max(5, Number(args['idle-sec']) || 25);
    const activeSec = Math.max(3, Number(args['active-sec']) || 8);
    const debounceSec = Math.max(0, Number(args['debounce-sec'] ?? 40));
    const once = Boolean(args.once);

    console.log(`[${ts()}] 🐇 零 Token 魔法信箱哨兵已启动 -> ${baseUrl} (关闭低频 ${idleSec}s / 开启高频 ${activeSec}s / 连聊缓冲 ${debounceSec}s)`);

    let lastPatrolEnabled = null;
    let lastErrorKey = '';
    let lastDebounceKey = '';

    while (true) {
        let nextDelaySec = idleSec;

        try {
            const data = await pollOnce(baseUrl);
            if (lastErrorKey) {
                console.log(`[${ts()}] ✅ 云端连接已恢复 (${baseUrl})`);
                lastErrorKey = '';
            }

            const patrolEnabled = Boolean(data.patrol?.enabled);
            const pendingCount = Number(data.pendingCount) || 0;
            const pendingWishes = Array.isArray(data.pendingWishes) ? data.pendingWishes : [];

            if (once || lastPatrolEnabled === null || lastPatrolEnabled !== patrolEnabled) {
                const rem = Number(data.patrol?.remainingMinutes) || 0;
                const ttlStr = patrolEnabled && rem > 0 ? `，约 ${rem} 分钟后自动休息` : '';
                const stateLabel = patrolEnabled ? `开启（高频 ${activeSec}s 巡检${ttlStr}）` : `关闭（低频 ${idleSec}s 待命）`;
                console.log(`[${ts()}] 🎛️ 网页巡检开关：${stateLabel} · 待处理留言：${pendingCount} 条`);
                lastPatrolEnabled = patrolEnabled;
            }

            if (patrolEnabled && pendingCount > 0 && pendingWishes.length > 0) {
                const serverNow = Number(data.serverTime) || Date.now();
                const latestPendingAt = Number(data.latestPendingAt) || pendingWishes.reduce((mx, w) => Math.max(mx, Number(w.createdAt) || 0), 0);
                const dispatchRequestedAt = Number(data.dispatchRequestedAt) || 0;
                const userDispatched = dispatchRequestedAt > 0 && dispatchRequestedAt >= latestPendingAt;
                const quietSec = latestPendingAt > 0 ? Math.max(0, (serverNow - latestPendingAt) / 1000) : debounceSec;

                if (userDispatched || quietSec >= debounceSec) {
                    console.log(`\n[${ts()}] 🌟 ${userDispatched ? '小豌豆已点击「立刻开工」' : `已静默等待 ${Math.round(quietSec)}s 确认说完`}，共 ${pendingWishes.length} 条新点子待处理！`);
                    for (const w of pendingWishes) {
                        const loc = w.bookTitle ? `《${w.bookTitle}》第${w.pageNumber || 1}页 (${w.mode || 'storybook'})` : '魔法书架';
                        console.log(`- [${w.id}] (${w.createdStr || ''}) ${w.kidName || '小豌豆'} @ ${loc}`);
                        if (w.target && typeof w.target === 'object') {
                            const tParts = [
                                w.target.scope ? `范围=${w.target.scope}` : '',
                                w.target.panelNumber > 0 ? `第${w.target.panelNumber}格` : '',
                                w.target.characterName ? `角色=${w.target.characterEmoji || ''}${w.target.characterName}` : '',
                                w.target.actionType ? `意图=${w.target.actionType}` : '',
                                w.target.snippet ? `原文=“${w.target.snippet}”` : ''
                            ].filter(Boolean);
                            if (tParts.length > 0) console.log(`  🎯 定位：${tParts.join(' · ')}`);
                        }
                        console.log(`  💬 “${w.text}”`);
                    }
                    console.log('\n🚀 立即退出哨兵并唤醒画师开始创作！');
                    process.exit(0);
                } else {
                    const remainSec = Math.max(1, Math.ceil(debounceSec - quietSec));
                    const dKey = `${pendingCount}:${latestPendingAt}`;
                    if (once || dKey !== lastDebounceKey) {
                        console.log(`[${ts()}] ⏳ 收到 ${pendingCount} 条留言，正在等小豌豆补充完（约 ${remainSec}s 后或点「立刻开工」即唤醒）…`);
                        lastDebounceKey = dKey;
                    }
                    nextDelaySec = Math.min(activeSec, Math.max(3, remainSec));
                }
            } else {
                lastDebounceKey = '';
                nextDelaySec = patrolEnabled ? activeSec : idleSec;
            }
        } catch (err) {
            const msg = String(err?.message || err);
            const errKey = msg.slice(0, 80);
            if (once || errKey !== lastErrorKey) {
                console.warn(`[${ts()}] ⚠️ 轮询暂未就绪 (${msg})，将于 ${idleSec}s 后自动重试…`);
                lastErrorKey = errKey;
            }
            nextDelaySec = idleSec;
        }

        if (once) {
            process.exit(0);
        }

        await sleep(nextDelaySec * 1000);
    }
}

main().catch((err) => {
    console.error('❌ 哨兵异常退出:', err?.message || err);
    process.exit(1);
});
