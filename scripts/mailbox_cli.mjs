#!/usr/bin/env node
/**
 * scripts/mailbox_cli.mjs - 🪄 魔法故事画师（Antigravity）专用云端传声屋收发工具
 *
 * 用法：
 *   1. 绑定线上网址（只需一次）：
 *      node scripts/mailbox_cli.mjs set-url https://<你的线上域名>
 *   2. 拉取查看小豌豆最新语音/文字灵感留言：
 *      node scripts/mailbox_cli.mjs pull [--url https://...]
 *   3. 推送正式回信给小豌豆（网页端会自动角标提醒、真人语音播报，并支持一键跳到新书新页）：
 *      node scripts/mailbox_cli.mjs reply --to <wishId> --book <bookId> --page <pageNumber> --badge "🎉 新故事画好啦！" --text "回信内容..."
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

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
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

function normalizeUrl(u) {
    if (!u) return '';
    let s = String(u).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s;
}

function nowTimeStr() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${mi}`;
}

function getBaseUrlOrExit(args) {
    const cfg = loadConfig();
    const baseUrl = normalizeUrl(args.url || process.env.MAILBOX_URL || cfg.baseUrl);
    if (!baseUrl) {
        console.error('❌ 尚未配置线上故事屋网址！请先运行：\n   node scripts/mailbox_cli.mjs set-url https://<你的线上网址>');
        process.exit(1);
    }
    if (args.url && baseUrl !== cfg.baseUrl) {
        saveConfig({ ...cfg, baseUrl });
    }
    return baseUrl;
}

async function cmdPull(args) {
    const baseUrl = getBaseUrlOrExit(args);
    const res = await fetch(`${baseUrl}/api/mailbox`, {
        headers: { Accept: 'application/json' }
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const wishes = Array.isArray(data.wishes) ? data.wishes : [];
    const replies = Array.isArray(data.replies) ? data.replies : [];

    console.log(`\n🪄 云端魔法传声屋同步成功 (${baseUrl})`);
    console.log(`   共收到小豌豆留言 ${wishes.length} 条 · 已发画师回信 ${replies.length} 封\n`);

    if (wishes.length === 0) {
        console.log('📭 目前还没有新的小豌豆留言哦！');
        return;
    }

    for (const w of wishes) {
        const tag = w.status === 'fulfilled' ? '✅[已画完]' : (w.status === 'read' ? '👀[已读]' : '🌟[新点子]');
        const loc = w.bookTitle ? `《${w.bookTitle}》第${w.pageNumber || 1}页 (${w.mode})` : '魔法书架';
        console.log(`${tag} [${w.createdStr}] ${w.kidName || '小豌豆'} @ ${loc} [ID: ${w.id}]`);
        console.log(`   💬 小豌豆说：“${w.text}”`);
        if (w.instantReplyText) {
            console.log(`   🧠 实时陪聊：“${w.instantReplyText}”`);
        }
        console.log('');
    }
}

async function cmdReply(args) {
    const text = String(args.text || '').trim();
    if (!text) {
        console.error('❌ 请提供 --text "回信内容"');
        process.exit(1);
    }
    const baseUrl = getBaseUrlOrExit(args);

    const entry = {
        id: args.id || `reply_${Date.now()}`,
        replyToId: String(args.to || ''),
        senderName: '魔法故事画师',
        badgeTitle: String(args.badge || '🎉 新故事画好啦！'),
        bookId: String(args.book || ''),
        pageNumber: Math.max(1, Number(args.page) || 1),
        createdAt: Date.now(),
        createdStr: nowTimeStr(),
        text
    };

    const res = await fetch(`${baseUrl}/api/mailbox/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry)
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    console.log(`☁️ 已推送画师回信到云端传声屋 (${baseUrl}) [ID: ${entry.id}]！`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0] || 'pull';

    if (cmd === 'set-url') {
        const url = normalizeUrl(args._[1] || args.url);
        if (!url) {
            console.error('❌ 用法: node scripts/mailbox_cli.mjs set-url https://...');
            process.exit(1);
        }
        const cfg = loadConfig();
        saveConfig({ ...cfg, baseUrl: url });
        console.log(`✅ 已保存线上故事屋网址: ${url}`);
        return;
    }

    if (cmd === 'pull') {
        await cmdPull(args);
        return;
    }

    if (cmd === 'reply') {
        await cmdReply(args);
        return;
    }

    console.log('支持的命令: set-url | pull | reply');
}

main().catch((err) => {
    console.error('❌ 执行出错:', err.message || err);
    process.exit(1);
});
