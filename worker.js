/**
 * worker.js - 《🐰 小豌豆魔法故事漫画屋》Cloudflare Worker 服务端入口
 * 职责：
 * 1. /api/tts：复用 Edge Neural TTS（edgeTtsMod.js），为绘本旁白、漫画多角色气泡与播报提供实时真人神经网络语音 MP3；
 * 2. /api/mailbox/transcribe：调用 Cloudflare Workers AI（Whisper / Nova-3）把小豌豆的语音精准转成中文文字；
 * 3. /api/mailbox*：通过 Workers AI 实时陪聊 + SQLite Durable Object 云端持久化小豌豆的灵感留言与魔法故事画师回信；
 * 4. /api/health：健康检查与服务能力；
 * 5. 其余静态资源交由 Cloudflare Assets 分发，并对 /version.json 及 *.json 强制禁用边缘缓存，确保 iPad 3 秒热刷新零延迟。
 */
import { DurableObject } from "cloudflare:workers";
import { ROLE_NEURAL_VOICES, synthesizeNeuralMp3Base64 } from "./edgeTtsMod.js";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};

const AI_MODEL_CHAIN = [
    "@cf/qwen/qwen3-30b-a3b-fp8",
    "@cf/google/gemma-3-12b-it",
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-3.1-8b-instruct"
];

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate",
            ...CORS_HEADERS
        }
    });
}

function cleanStr(val, maxLen = 600) {
    if (val === undefined || val === null) return "";
    return String(val).trim().slice(0, maxLen);
}

function sanitizeAiReplyText(raw) {
    if (!raw) return "";
    let s = String(raw)
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<\/?think>/gi, "")
        .replace(/[*#`~_>]/g, "")
        .replace(/\n{2,}/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if ((s.startsWith("“") && s.endsWith("”")) || (s.startsWith('"') && s.endsWith('"'))) {
        s = s.slice(1, -1).trim();
    }
    return s.slice(0, 260);
}

function extractModelContent(res) {
    if (!res) return "";
    if (typeof res === "string") return res;
    if (typeof res.response === "string" && res.response.trim()) return res.response;
    if (Array.isArray(res.choices) && res.choices[0]?.message?.content) {
        const c = res.choices[0].message.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) return c.map((part) => part?.text || "").join("");
    }
    if (res.result && typeof res.result.response === "string") return res.result.response;
    return "";
}

function base64ToUint8Array(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
}

function uint8ToBase64(u8) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < u8.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function cleanWhisperTranscript(raw) {
    if (!raw) return "";
    let s = String(raw).trim();
    if (!s) return "";
    if (/^(字幕|谢谢观看|感谢观看|请不吝点赞|订阅|简体中文普通话|Amara\.org|Subtitles by|Thank you for watching)/i.test(s) && s.length < 24) {
        return "";
    }
    s = s
        .replace(/小碗豆|小弯豆/g, "小豌豆")
        .replace(/麻鼠兔|马薯兔/g, "麻薯兔")
        .replace(/云朵雄/g, "云朵熊");
    return s.slice(0, 500);
}

async function transcribeAudioFast(aiBinding, { rawBytes = null, audioBase64 = "", contentType = "audio/webm" } = {}) {
    if (!aiBinding || typeof aiBinding.run !== "function") {
        throw new Error("ai_binding_unavailable");
    }

    let bytes = rawBytes;
    let cleanB64 = String(audioBase64 || "").replace(/^data:audio\/[^;]+;base64,/i, "").trim();

    if (bytes && bytes.byteLength > 0) {
        if (bytes.byteLength > 3_500_000) throw new Error("audio_too_large");
        cleanB64 = uint8ToBase64(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    } else if (cleanB64) {
        if (cleanB64.length > 4_500_000) throw new Error("audio_too_large");
        bytes = base64ToUint8Array(cleanB64);
    }

    if (!cleanB64 || cleanB64.length < 64) {
        return { text: "", model: "empty" };
    }

    try {
        const res = await aiBinding.run("@cf/openai/whisper-large-v3-turbo", {
            audio: cleanB64,
            language: "zh",
            task: "transcribe",
            beam_size: 5,
            condition_on_previous_text: false,
            vad_filter: false,
            initial_prompt: "简体中文普通话。小豌豆，麻薯兔，云朵熊，糖糖星。"
        });
        const txt = cleanWhisperTranscript(res?.text ?? res?.result?.text ?? "");
        if (txt) {
            return { text: txt, model: "@cf/openai/whisper-large-v3-turbo" };
        }
    } catch (_) {}

    if (bytes && bytes.byteLength > 64) {
        try {
            const dgRes = await aiBinding.run("@cf/deepgram/nova-3", {
                audio: {
                    body: bytes,
                    contentType: contentType || "audio/webm"
                },
                language: "zh-CN",
                smart_format: true
            });
            const dgTxt = cleanWhisperTranscript(
                dgRes?.text ??
                dgRes?.results?.channels?.[0]?.alternatives?.[0]?.transcript ??
                ""
            );
            if (dgTxt) {
                return { text: dgTxt, model: "@cf/deepgram/nova-3" };
            }
        } catch (_) {}
    }

    const arrBytes = bytes instanceof Uint8Array ? bytes : base64ToUint8Array(cleanB64);
    const res2 = await aiBinding.run("@cf/openai/whisper", {
        audio: Array.from(arrBytes)
    });
    const txt2 = cleanWhisperTranscript(res2?.text ?? res2?.result?.text ?? "");
    return { text: txt2, model: "@cf/openai/whisper" };
}

function buildStoryArtistSystemPrompt({ bookTitle, pageNumber, mode }) {
    const contextDesc = bookTitle
        ? `当前小豌豆正在看《${bookTitle}》第 ${pageNumber || 1} 页（${mode === "comic" ? "彩色多格漫画模式" : "精装有声绘本模式"}）。`
        : "当前小豌豆正在她的魔法书架前挑选故事书。";

    return [
        "你是【🐰 小豌豆魔法故事漫画屋】里温柔、风趣、充满想象力的「魔法故事画师大姐姐」，正在陪伴二年级小朋友【小豌豆】一起创作原创绘本与彩色漫画。",
        contextDesc,
        "请严格遵守以下回复准则：",
        "1. 亲切称呼“小豌豆”，认真倾听并回应她的每一个想法。",
        "2. 如果小豌豆提出了想画的新故事、续写下一页、改某页台词/剧情、加新角色或神奇魔法：请先热烈夸奖她的灵感并顺着她的脑洞畅想一下画面有多棒，再告诉她「我已经用魔法画笔记进云端魔法画本里啦，很快就会画成全彩绘本和漫画变到你的书架上！」。",
        "3. 如果小豌豆只是打招呼、问问题或讲日常趣事：请用温暖、有童趣、适合二年级小朋友听的语言陪她聊天互动。",
        "4. 字数控制在 45 到 115 个汉字之间，纯自然口语段落，不要使用换行列表、星号或 Markdown 符号，最多带 1 到 2 个可爱表情，方便直接转成温柔真人语音。",
        "5. 内容绝对健康安全，鼓励想象力。不要输出思考过程，直接输出对小豌豆说的话。"
    ].join("\n");
}

async function generateStoryArtistReply(aiBinding, { text, bookTitle = "", pageNumber = 1, mode = "storybook", recentTurns = [] }) {
    if (!aiBinding || typeof aiBinding.run !== "function") {
        return null;
    }

    const messages = [
        { role: "system", content: buildStoryArtistSystemPrompt({ bookTitle, pageNumber, mode }) }
    ];

    for (const turn of recentTurns.slice(-6)) {
        if (turn.text) {
            messages.push({ role: "user", content: `[小豌豆]: ${turn.text}` });
        }
        if (turn.instantReplyText) {
            messages.push({ role: "assistant", content: turn.instantReplyText });
        }
    }

    messages.push({ role: "user", content: `[小豌豆]: ${text}` });

    for (const modelId of AI_MODEL_CHAIN) {
        try {
            const payload = {
                messages,
                max_tokens: 260,
                temperature: 0.76
            };
            if (modelId.includes("qwen3")) {
                payload.chat_template_kwargs = { enable_thinking: false };
            }
            const rawRes = await aiBinding.run(modelId, payload);
            const cleaned = sanitizeAiReplyText(extractModelContent(rawRes));
            if (cleaned && cleaned.length >= 4) {
                return { text: cleaned, model: modelId };
            }
        } catch (_) {}
    }
    return null;
}

function buildFallbackArtistReply(text, bookTitle) {
    const snippet = cleanStr(text, 28);
    if (bookTitle) {
        return `哇，小豌豆的想象力闪闪发光！你刚说的「${snippet}」放在《${bookTitle}》里一定超精彩，我已经记进云端魔法画本里啦，很快就会画好送到你书架上哦！`;
    }
    return `太棒啦小豌豆！你说的「${snippet}」充满童话魔法感，我已经拿彩色画笔记进云端魔法画本里啦，很快就会变成新故事摆上你的书架哦！`;
}

export class StoryMailboxDO extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.env = env;
        ctx.blockConcurrencyWhile(async () => {
            this.ctx.storage.sql.exec(`
                CREATE TABLE IF NOT EXISTS story_wishes (
                    id TEXT PRIMARY KEY,
                    kid_name TEXT NOT NULL,
                    book_id TEXT DEFAULT '',
                    book_title TEXT DEFAULT '',
                    page_number INTEGER DEFAULT 1,
                    mode TEXT DEFAULT 'shelf',
                    text TEXT NOT NULL,
                    instant_reply_key TEXT DEFAULT '',
                    instant_reply_text TEXT DEFAULT '',
                    status TEXT DEFAULT 'pending',
                    created_at INTEGER NOT NULL,
                    created_str TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS artist_replies (
                    id TEXT PRIMARY KEY,
                    reply_to_id TEXT DEFAULT '',
                    sender_name TEXT DEFAULT '魔法故事画师',
                    badge_title TEXT DEFAULT '🎉 新故事画好啦！',
                    book_id TEXT DEFAULT '',
                    page_number INTEGER DEFAULT 1,
                    text TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    created_str TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS mailbox_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
            `);
        });
    }

    _getSetting(key, defaultValue = "") {
        const rows = this.ctx.storage.sql.exec(
            `SELECT value, updated_at AS updatedAt FROM mailbox_settings WHERE key = ? LIMIT 1`,
            key
        ).toArray();
        if (rows.length === 0) {
            return { value: defaultValue, updatedAt: 0 };
        }
        return {
            value: String(rows[0].value ?? defaultValue),
            updatedAt: Number(rows[0].updatedAt) || 0
        };
    }

    _setSetting(key, value, now = Date.now()) {
        this.ctx.storage.sql.exec(
            `INSERT INTO mailbox_settings (key, value, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at`,
            key,
            String(value),
            now
        );
    }

    _getPatrolState() {
        const enabledRow = this._getSetting("patrol_enabled", "0");
        const hbRow = this._getSetting("watcher_heartbeat_at", "0");
        const byRow = this._getSetting("patrol_updated_by", "");
        const watcherLastSeenAt = Number(hbRow.value) || 0;
        const watcherOnline = watcherLastSeenAt > 0 && (Date.now() - watcherLastSeenAt) < 60_000;
        return {
            enabled: enabledRow.value === "1" || enabledRow.value === "true",
            updatedAt: enabledRow.updatedAt || 0,
            updatedBy: byRow.value || "",
            watcherLastSeenAt,
            watcherOnline
        };
    }

    _readPendingWishes() {
        return this.ctx.storage.sql.exec(
            `SELECT id, kid_name AS kidName, book_id AS bookId, book_title AS bookTitle,
                    page_number AS pageNumber, mode, text,
                    created_at AS createdAt, created_str AS createdStr
             FROM story_wishes
             WHERE status = 'pending'
             ORDER BY created_at ASC
             LIMIT 20`
        ).toArray();
    }

    _readAll() {
        const wishes = this.ctx.storage.sql.exec(
            `SELECT id, kid_name AS kidName, book_id AS bookId, book_title AS bookTitle,
                    page_number AS pageNumber, mode, text,
                    instant_reply_key AS instantReplyKey, instant_reply_text AS instantReplyText,
                    status, created_at AS createdAt, created_str AS createdStr
             FROM story_wishes
             ORDER BY created_at ASC
             LIMIT 200`
        ).toArray();

        const replies = this.ctx.storage.sql.exec(
            `SELECT id, reply_to_id AS replyToId, sender_name AS senderName,
                    badge_title AS badgeTitle, book_id AS bookId, page_number AS pageNumber,
                    text, created_at AS createdAt, created_str AS createdStr
             FROM artist_replies
             ORDER BY created_at ASC
             LIMIT 200`
        ).toArray();

        return { wishes, replies };
    }

    _upsertWish(raw) {
        if (!raw || typeof raw !== "object") return null;
        const text = cleanStr(raw.text, 600);
        if (!text) return null;
        const now = Date.now();
        const id = cleanStr(raw.id, 80) || `wish_${now}_${Math.random().toString(36).slice(2, 7)}`;
        const kidName = cleanStr(raw.kidName, 30) || "小豌豆";
        const bookId = cleanStr(raw.bookId, 80);
        const bookTitle = cleanStr(raw.bookTitle, 80);
        const pageNumber = Math.max(1, Number(raw.pageNumber) || 1);
        const mode = cleanStr(raw.mode, 24) || "shelf";
        const instantReplyKey = cleanStr(raw.instantReplyKey, 48);
        const instantReplyText = cleanStr(raw.instantReplyText, 600);
        const createdAt = Number(raw.createdAt) > 0 ? Math.floor(Number(raw.createdAt)) : now;
        const createdStr = cleanStr(raw.createdStr, 32) || new Date(createdAt).toISOString().slice(5, 16).replace("T", " ");

        this.ctx.storage.sql.exec(
            `INSERT INTO story_wishes
                (id, kid_name, book_id, book_title, page_number, mode, text, instant_reply_key, instant_reply_text, status, created_at, created_str)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                instant_reply_key = CASE WHEN excluded.instant_reply_key != '' THEN excluded.instant_reply_key ELSE story_wishes.instant_reply_key END,
                instant_reply_text = CASE WHEN excluded.instant_reply_text != '' THEN excluded.instant_reply_text ELSE story_wishes.instant_reply_text END`,
            id, kidName, bookId, bookTitle, pageNumber, mode, text, instantReplyKey, instantReplyText, createdAt, createdStr
        );

        this.ctx.storage.sql.exec(
            `DELETE FROM story_wishes WHERE id NOT IN (
                SELECT id FROM story_wishes ORDER BY created_at DESC LIMIT 200
            )`
        );
        return { id, kidName, bookId, bookTitle, pageNumber, mode, text, instantReplyKey, instantReplyText, createdAt, createdStr };
    }

    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        try {
            if (request.method === "GET" && (path === "/api/mailbox" || path === "/api/mailbox/")) {
                const { wishes, replies } = this._readAll();
                return jsonResponse({
                    ok: true,
                    wishes,
                    replies,
                    patrol: this._getPatrolState(),
                    serverTime: Date.now()
                });
            }

            if (request.method === "GET" && path === "/api/mailbox/patrol") {
                if (url.searchParams.get("watcher") === "1") {
                    this._setSetting("watcher_heartbeat_at", String(Date.now()));
                }
                const pendingWishes = this._readPendingWishes();
                return jsonResponse({
                    ok: true,
                    patrol: this._getPatrolState(),
                    pendingCount: pendingWishes.length,
                    pendingWishes,
                    serverTime: Date.now()
                });
            }

            if (request.method === "POST" && path === "/api/mailbox/patrol") {
                const body = await request.json().catch(() => ({}));
                if (typeof body.enabled !== "boolean") {
                    return jsonResponse({ ok: false, error: "invalid_enabled" }, 400);
                }
                const now = Date.now();
                this._setSetting("patrol_enabled", body.enabled ? "1" : "0", now);
                this._setSetting("patrol_updated_by", cleanStr(body.source, 24) || "web", now);
                return jsonResponse({
                    ok: true,
                    patrol: this._getPatrolState(),
                    serverTime: now
                });
            }

            if (request.method === "POST" && path === "/api/mailbox/wish") {
                const body = await request.json().catch(() => ({}));
                const text = cleanStr(body.text, 600);
                if (!text) {
                    return jsonResponse({ ok: false, error: "empty_text" }, 400);
                }

                const bookTitle = cleanStr(body.bookTitle, 80);
                const pageNumber = Math.max(1, Number(body.pageNumber) || 1);
                const mode = cleanStr(body.mode, 24) || "shelf";
                const prevData = this._readAll();

                let replyKey = "local_fallback";
                let replyText = cleanStr(body.fallbackReplyText, 600) || buildFallbackArtistReply(text, bookTitle);
                let aiGenerated = false;
                let aiModel = "";
                let audioBase64 = "";

                const aiRes = await generateStoryArtistReply(this.env?.AI, {
                    text,
                    bookTitle,
                    pageNumber,
                    mode,
                    recentTurns: prevData.wishes.slice(-6)
                });

                if (aiRes && aiRes.text) {
                    replyKey = "ai_live";
                    replyText = aiRes.text;
                    aiGenerated = true;
                    aiModel = aiRes.model;
                }

                try {
                    audioBase64 = await synthesizeNeuralMp3Base64(replyText, "narrator");
                } catch (_) {
                    audioBase64 = "";
                }

                this._upsertWish({
                    ...body,
                    instantReplyKey: replyKey,
                    instantReplyText: replyText
                });

                const { wishes, replies } = this._readAll();
                return jsonResponse({
                    ok: true,
                    aiGenerated,
                    aiModel,
                    replyKey,
                    replyText,
                    audioBase64,
                    wishes,
                    replies,
                    serverTime: Date.now()
                });
            }

            if (request.method === "POST" && path === "/api/mailbox/sync") {
                const body = await request.json().catch(() => ({}));
                if (Array.isArray(body.wishes)) {
                    for (const w of body.wishes.slice(0, 50)) {
                        this._upsertWish(w);
                    }
                }
                const { wishes, replies } = this._readAll();
                return jsonResponse({ ok: true, wishes, replies, serverTime: Date.now() });
            }

            if (request.method === "POST" && path === "/api/mailbox/reply") {
                const body = await request.json().catch(() => ({}));
                const text = cleanStr(body.text, 1000);
                if (!text) {
                    return jsonResponse({ ok: false, error: "empty_reply_text" }, 400);
                }
                const now = Date.now();
                const id = cleanStr(body.id, 80) || `reply_${now}`;
                const replyToId = cleanStr(body.replyToId, 200);
                const senderName = cleanStr(body.senderName, 32) || "魔法故事画师";
                const badgeTitle = cleanStr(body.badgeTitle, 48) || "🎉 新故事画好啦！";
                const bookId = cleanStr(body.bookId, 80);
                const pageNumber = Math.max(1, Number(body.pageNumber) || 1);
                const createdAt = Number(body.createdAt) > 0 ? Math.floor(Number(body.createdAt)) : now;
                const createdStr = cleanStr(body.createdStr, 32) || new Date(createdAt).toISOString().slice(5, 16).replace("T", " ");

                this.ctx.storage.sql.exec(
                    `INSERT INTO artist_replies
                        (id, reply_to_id, sender_name, badge_title, book_id, page_number, text, created_at, created_str)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET
                        reply_to_id = excluded.reply_to_id,
                        badge_title = excluded.badge_title,
                        book_id = excluded.book_id,
                        page_number = excluded.page_number,
                        text = excluded.text`,
                    id, replyToId, senderName, badgeTitle, bookId, pageNumber, text, createdAt, createdStr
                );

                if (replyToId) {
                    const ids = replyToId.split(",").map((s) => s.trim()).filter(Boolean);
                    for (const wid of ids) {
                        this.ctx.storage.sql.exec(`UPDATE story_wishes SET status = 'fulfilled' WHERE id = ?`, wid);
                    }
                }

                this.ctx.storage.sql.exec(
                    `DELETE FROM artist_replies WHERE id NOT IN (
                        SELECT id FROM artist_replies ORDER BY created_at DESC LIMIT 200
                    )`
                );

                const { wishes, replies } = this._readAll();
                return jsonResponse({ ok: true, wishes, replies, serverTime: Date.now() });
            }

            if (request.method === "POST" && path === "/api/mailbox/status") {
                const body = await request.json().catch(() => ({}));
                const status = cleanStr(body.status, 24);
                if (Array.isArray(body.ids) && ["pending", "read", "fulfilled"].includes(status)) {
                    for (const wid of body.ids.slice(0, 100)) {
                        this.ctx.storage.sql.exec(`UPDATE story_wishes SET status = ? WHERE id = ?`, status, cleanStr(wid, 80));
                    }
                }
                if (Array.isArray(body.deleteIds)) {
                    for (const wid of body.deleteIds.slice(0, 100)) {
                        this.ctx.storage.sql.exec(`DELETE FROM story_wishes WHERE id = ?`, cleanStr(wid, 80));
                    }
                }
                const { wishes, replies } = this._readAll();
                return jsonResponse({ ok: true, wishes, replies, serverTime: Date.now() });
            }

            return jsonResponse({ ok: false, error: "not_found" }, 404);
        } catch (err) {
            return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
        }
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (url.pathname === "/api/health" && request.method === "GET") {
            return jsonResponse({
                ok: true,
                service: "pea-story-house",
                voices: Object.keys(ROLE_NEURAL_VOICES),
                ai: Boolean(env?.AI),
                mailbox: Boolean(env?.STORY_MAILBOX)
            });
        }

        if (url.pathname === "/api/tts") {
            if (request.method === "POST") {
                try {
                    const body = await request.json().catch(() => ({}));
                    const text = cleanStr(body.text, 600);
                    const role = cleanStr(body.role, 32) || "narrator";
                    if (!text) {
                        return jsonResponse({ ok: false, error: "empty_text" }, 400);
                    }
                    const audioBase64 = await synthesizeNeuralMp3Base64(text, role);
                    return jsonResponse({ ok: true, role, audioBase64 });
                } catch (err) {
                    return jsonResponse({
                        ok: false,
                        error: String(err && err.message ? err.message : err)
                    }, 503);
                }
            }
            return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
        }

        if (url.pathname.startsWith("/api/mailbox")) {
            if (request.method === "POST" && url.pathname === "/api/mailbox/transcribe") {
                try {
                    const ctype = (request.headers.get("content-type") || "").toLowerCase();
                    let result;
                    if (ctype.includes("application/json")) {
                        const body = await request.json().catch(() => ({}));
                        result = await transcribeAudioFast(env?.AI, { audioBase64: body.audioBase64 });
                    } else {
                        const ab = await request.arrayBuffer();
                        result = await transcribeAudioFast(env?.AI, {
                            rawBytes: new Uint8Array(ab),
                            contentType: ctype || "audio/webm"
                        });
                    }
                    return jsonResponse({ ok: true, text: result.text, model: result.model });
                } catch (err) {
                    return jsonResponse({
                        ok: false,
                        error: String(err && err.message ? err.message : err)
                    }, 500);
                }
            }

            if (env && env.STORY_MAILBOX) {
                const id = env.STORY_MAILBOX.idFromName("pea-story-house-mailbox-v1");
                const stub = env.STORY_MAILBOX.get(id);
                return stub.fetch(request);
            }
            return jsonResponse({ ok: false, error: "mailbox_binding_unavailable" }, 503);
        }

        if (env && env.ASSETS) {
            const assetResp = await env.ASSETS.fetch(request);
            if (url.pathname === "/version.json" || url.pathname.endsWith(".json")) {
                const headers = new Headers(assetResp.headers);
                headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
                headers.set("Pragma", "no-cache");
                return new Response(assetResp.body, {
                    status: assetResp.status,
                    statusText: assetResp.statusText,
                    headers
                });
            }
            return assetResp;
        }

        return new Response("Not Found", { status: 404 });
    }
};
