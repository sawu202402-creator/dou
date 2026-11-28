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
import { ROLE_NEURAL_VOICES, getRoleVoiceProfile, stripSpeechTextForTts, synthesizeNeuralMp3Base64 } from "./edgeTtsMod.js";
import { VoiceNotFoundError, enrollClonedVoice, getVoiceCloneConfig, synthesizeClonedSpeech } from "./voiceCloneMod.js";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token, X-Story-Hints"
};

const PATROL_AUTO_OFF_MS = 60 * 60 * 1000;

const AI_MODEL_CHAIN = [
    "@cf/qwen/qwen3-30b-a3b-fp8",
    "@cf/google/gemma-3-12b-it",
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-3.1-8b-instruct"
];

function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate",
            ...CORS_HEADERS,
            ...extraHeaders
        }
    });
}

function cleanStr(val, maxLen = 600) {
    if (val === undefined || val === null) return "";
    return String(val).trim().slice(0, maxLen);
}

function sanitizeVoiceRole(raw) {
    const clean = cleanStr(raw, 32).replace(/[^a-zA-Z0-9_-]/g, "");
    return clean || "pea";
}

async function runClonedTtsWithEnroll({ vcCfg, cleanText, profile, syncFn }) {
    let providerVoiceId = vcCfg.overrideVoiceId || (profile.provider === vcCfg.provider ? cleanStr(profile.providerVoiceId, 260) : "");
    if (!providerVoiceId) {
        if (!profile.hasSample) {
            throw new VoiceNotFoundError("missing_voice_sample");
        }
        providerVoiceId = await enrollClonedVoice(vcCfg, {
            sampleAudioB64: profile.sampleAudioB64,
            sampleMime: profile.sampleMime,
            sampleText: profile.sampleText,
            version: profile.version || 1
        });
        await syncFn({
            provider: vcCfg.provider,
            providerVoiceId,
            syncedAt: Date.now(),
            lastError: ""
        });
    }

    try {
        const res = await synthesizeClonedSpeech(vcCfg, {
            text: cleanText,
            providerVoiceId,
            sampleAudioB64: profile.sampleAudioB64,
            sampleText: profile.sampleText
        });
        return { audioBase64: res.audioBase64, providerVoiceId };
    } catch (err) {
        if (err instanceof VoiceNotFoundError && !vcCfg.overrideVoiceId && profile.hasSample) {
            const refreshedId = await enrollClonedVoice(vcCfg, {
                sampleAudioB64: profile.sampleAudioB64,
                sampleMime: profile.sampleMime,
                sampleText: profile.sampleText,
                version: profile.version || 1
            });
            await syncFn({
                provider: vcCfg.provider,
                providerVoiceId: refreshedId,
                syncedAt: Date.now(),
                lastError: ""
            });
            const retryRes = await synthesizeClonedSpeech(vcCfg, {
                text: cleanText,
                providerVoiceId: refreshedId,
                sampleAudioB64: profile.sampleAudioB64,
                sampleText: profile.sampleText
            });
            return { audioBase64: retryRes.audioBase64, providerVoiceId: refreshedId };
        }
        throw err;
    }
}

function safeParseJson(str) {
    if (!str || typeof str !== "string") return null;
    try {
        const obj = JSON.parse(str);
        return obj && typeof obj === "object" ? obj : null;
    } catch (_) {
        return null;
    }
}

const VALID_SCOPES = new Set(["new_book", "book", "page", "panel"]);
const VALID_ACTIONS = new Set(["art", "dialogue", "voice", "next_page", "general"]);

function sanitizeTarget(raw) {
    if (!raw || typeof raw !== "object") return null;
    const scope = VALID_SCOPES.has(raw.scope) ? raw.scope : "page";
    const panelNumber = Math.max(0, Math.min(20, Math.floor(Number(raw.panelNumber) || 0)));
    const actionType = VALID_ACTIONS.has(raw.actionType) ? raw.actionType : "general";
    const characterId = cleanStr(raw.characterId, 48);
    const characterName = cleanStr(raw.characterName, 32);
    const characterEmoji = cleanStr(raw.characterEmoji, 16);
    const previewImage = cleanStr(raw.previewImage, 220);
    const pageTitle = cleanStr(raw.pageTitle, 80);
    const snippet = cleanStr(raw.snippet, 180);
    return {
        scope,
        panelNumber,
        actionType,
        characterId,
        characterName,
        characterEmoji,
        previewImage,
        pageTitle,
        snippet
    };
}

function sanitizePageContext(raw) {
    if (!raw || typeof raw !== "object") return null;
    const pageTitle = cleanStr(raw.pageTitle, 80);
    const storySummary = cleanStr(raw.storySummary, 240);
    const panelCaption = cleanStr(raw.panelCaption, 140);
    const characters = Array.isArray(raw.characters)
        ? raw.characters.slice(0, 8).map((c) => ({
            name: cleanStr(c?.name, 24),
            emoji: cleanStr(c?.emoji, 12)
        })).filter((c) => c.name)
        : [];
    const bubbles = Array.isArray(raw.bubbles)
        ? raw.bubbles.slice(0, 6).map((b) => ({
            characterName: cleanStr(b?.characterName, 24),
            text: cleanStr(b?.text, 80)
        })).filter((b) => b.text)
        : [];
    if (!pageTitle && !storySummary && !panelCaption && characters.length === 0 && bubbles.length === 0) {
        return null;
    }
    return { pageTitle, storySummary, panelCaption, characters, bubbles };
}

function formatBeijingTimeStr(tsMs = Date.now()) {
    const d = new Date(Number(tsMs) + 8 * 3600 * 1000);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mi = String(d.getUTCMinutes()).padStart(2, "0");
    return `${mm}/${dd} ${hh}:${mi}`;
}

async function sha256Hex(str) {
    const bytes = new TextEncoder().encode(String(str || ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isAdminAuthorized(request, env) {
    const token = cleanStr(env?.MAILBOX_ADMIN_TOKEN, 200);
    if (!token) return true;
    const auth = cleanStr(request.headers.get("Authorization"), 240);
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const headerToken = cleanStr(request.headers.get("X-Admin-Token"), 200);
    return bearer === token || headerToken === token;
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

async function transcribeAudioFast(aiBinding, { rawBytes = null, audioBase64 = "", contentType = "audio/webm", hints = "" } = {}) {
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

    const cleanHints = cleanStr(hints, 140).replace(/[。\n\r]+/g, "，");
    const initialPrompt = cleanStr(
        cleanHints
            ? `简体中文普通话。小豌豆，麻薯兔，云朵熊，糖糖星，彩虹，烟烟，${cleanHints}`
            : "简体中文普通话。小豌豆，麻薯兔，云朵熊，糖糖星，彩虹，烟烟。",
        220
    );

    try {
        const res = await aiBinding.run("@cf/openai/whisper-large-v3-turbo", {
            audio: cleanB64,
            language: "zh",
            task: "transcribe",
            beam_size: 5,
            condition_on_previous_text: false,
            vad_filter: false,
            initial_prompt: initialPrompt
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

const ACTION_LABELS = {
    art: "修改插画画面",
    dialogue: "修改文字/台词",
    voice: "调整角色配音",
    next_page: "续写新的一页",
    general: "改进或新增内容"
};

function buildStoryArtistSystemPrompt({ bookTitle, pageNumber, mode, target = null, pageContext = null }) {
    const contextLines = [];
    if (bookTitle) {
        const panelPart = target?.panelNumber > 0 ? `第 ${target.panelNumber} 格` : "";
        const charPart = target?.characterName ? `，重点关注角色【${target.characterName}】` : "";
        const actionPart = target?.actionType && ACTION_LABELS[target.actionType] ? `（意图：${ACTION_LABELS[target.actionType]}）` : "";
        contextLines.push(
            `当前小豌豆选中的位置是《${bookTitle}》第 ${pageNumber || 1} 页${panelPart}${mode === "comic" ? "（漫画模式）" : "（绘本模式）"}${charPart}${actionPart}。`
        );
    } else {
        contextLines.push("当前小豌豆准备新编一本原创故事书。");
    }

    if (pageContext) {
        if (pageContext.pageTitle) contextLines.push(`这一页标题：《${pageContext.pageTitle}》。`);
        if (pageContext.panelCaption) contextLines.push(`当前格旁白：“${pageContext.panelCaption}”。`);
        if (pageContext.storySummary) contextLines.push(`这一页故事内容：${pageContext.storySummary}`);
        if (Array.isArray(pageContext.characters) && pageContext.characters.length > 0) {
            contextLines.push(`本页出场角色：${pageContext.characters.map((c) => c.name).join("、")}。`);
        }
        if (Array.isArray(pageContext.bubbles) && pageContext.bubbles.length > 0) {
            const bLines = pageContext.bubbles.map((b) => `${b.characterName || "角色"}说「${b.text}」`).join("；");
            contextLines.push(`对话台词：${bLines}。`);
        }
    }

    return [
        "你是【🐰 小豌豆魔法故事漫画屋】里温柔、风趣、充满想象力的「魔法故事画师大姐姐」，正在陪伴二年级小朋友【小豌豆】一起创作或修改原创绘本与彩色漫画。",
        ...contextLines,
        "请严格遵守以下回复准则：",
        "1. 亲切称呼“小豌豆”，结合上面看到的当前页/格画面和角色，认真回应她的想法。",
        "2. 如果小豌豆说得比较笼统（比如只说“不好看”“想改一下”而没说明改哪里）：先夸夸她的好眼光，然后结合当前这页的画面或角色提 1 个暖心具体的小选择题（例如“是想给XX换个造型/颜色，还是想让它改一句台词呀？”），温柔引导她用 1 句话说清楚。",
        "3. 如果小豌豆的创作或修改想法已经很明确（比如换衣服颜色、加新动物、改配音、续写下一页）：先热烈夸赞并简单复述确认你记下的修改位置和内容，再告诉她「我已经记进云端画本里啦！如果还有补充可以继续说，说完点下面的「说好啦，立刻开工」我就马上动笔画哦！」。",
        "4. 字数控制在 45 到 120 个汉字之间，纯自然口语段落，不要使用换行列表、星号或 Markdown 符号，最多带 1 到 2 个可爱表情，方便直接转成温柔真人语音。",
        "5. 内容绝对健康安全，鼓励想象力。不要输出思考过程，直接输出对小豌豆说的话。"
    ].join("\n");
}

async function generateStoryArtistReply(aiBinding, { text, bookTitle = "", pageNumber = 1, mode = "storybook", target = null, pageContext = null, recentTurns = [] }) {
    if (!aiBinding || typeof aiBinding.run !== "function") {
        return null;
    }

    const messages = [
        { role: "system", content: buildStoryArtistSystemPrompt({ bookTitle, pageNumber, mode, target, pageContext }) }
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
                max_tokens: 280,
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

function buildFallbackArtistReply(text, bookTitle, target = null) {
    const snippet = cleanStr(text, 28);
    if (bookTitle) {
        const panelText = target?.panelNumber > 0 ? `第 ${target.panelNumber} 格` : "";
        const charText = target?.characterName ? `的${target.characterName}` : "";
        return `收到小豌豆的好主意！关于《${bookTitle}》${panelText}${charText}的「${snippet}」我已经记进云端画本啦！还要补充可以继续说，说完点下面「说好啦，立刻开工」我就马上画！`;
    }
    return `太棒啦小豌豆！你说的「${snippet}」充满童话魔法感，我已经记进云端魔法画本里啦！还要补充可以继续说，说完点下面「说好啦，立刻开工」我就马上画！`;
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
                CREATE TABLE IF NOT EXISTS voice_profiles (
                    role TEXT PRIMARY KEY,
                    sample_audio_b64 TEXT NOT NULL,
                    sample_mime TEXT DEFAULT 'audio/wav',
                    sample_text TEXT DEFAULT '',
                    duration_ms INTEGER DEFAULT 0,
                    enabled INTEGER DEFAULT 1,
                    version INTEGER DEFAULT 1,
                    provider TEXT DEFAULT '',
                    provider_voice_id TEXT DEFAULT '',
                    provider_synced_at INTEGER DEFAULT 0,
                    last_error TEXT DEFAULT '',
                    updated_at INTEGER NOT NULL,
                    updated_str TEXT NOT NULL
                );
            `);
            try {
                this.ctx.storage.sql.exec(`ALTER TABLE story_wishes ADD COLUMN target_json TEXT DEFAULT ''`);
            } catch (_) {}
        });
    }

    _getVoiceProfileRow(role = "pea") {
        const cleanRole = sanitizeVoiceRole(role);
        const rows = this.ctx.storage.sql.exec(
            `SELECT role, sample_audio_b64, sample_mime, sample_text, duration_ms, enabled, version,
                    provider, provider_voice_id, provider_synced_at, last_error, updated_at, updated_str
             FROM voice_profiles WHERE role = ? LIMIT 1`,
            cleanRole
        ).toArray();
        return rows[0] || null;
    }

    _formatPublicVoiceProfile(row, role = "pea") {
        const cleanRole = sanitizeVoiceRole(role);
        const vc = getVoiceCloneConfig(this.env);
        const hasSample = Boolean(row && cleanStr(row.sample_audio_b64, 32));
        const enabled = row ? Number(row.enabled) !== 0 : Boolean(vc.overrideVoiceId);
        const providerVoiceSynced = Boolean(
            vc.configured &&
            (vc.overrideVoiceId || (hasSample && row?.provider === vc.provider && cleanStr(row?.provider_voice_id, 260)))
        );
        const cloneReady = Boolean(vc.configured && enabled && (hasSample || vc.overrideVoiceId));
        return {
            role: cleanRole,
            hasSample,
            enabled: (hasSample || Boolean(vc.overrideVoiceId)) ? enabled : false,
            version: row ? Number(row.version) || 1 : 0,
            durationMs: row ? Number(row.duration_ms) || 0 : 0,
            sampleText: row ? cleanStr(row.sample_text, 400) : "",
            sampleMime: row ? (cleanStr(row.sample_mime, 64) || "audio/wav") : "audio/wav",
            updatedAt: row ? Number(row.updated_at) || 0 : 0,
            updatedStr: row ? cleanStr(row.updated_str, 32) : "",
            cloneReady,
            provider: vc.provider,
            providerLabel: vc.providerLabel,
            providerConfigured: vc.configured,
            providerVoiceSynced,
            overrideVoiceConfigured: Boolean(vc.overrideVoiceId),
            lastError: row ? cleanStr(row.last_error, 260) : ""
        };
    }

    _updateVoiceSyncMetadata(role, { provider = "", providerVoiceId = "", syncedAt = 0, lastError = "" } = {}) {
        const cleanRole = sanitizeVoiceRole(role);
        this.ctx.storage.sql.exec(
            `UPDATE voice_profiles
             SET provider = ?, provider_voice_id = ?, provider_synced_at = ?, last_error = ?
             WHERE role = ?`,
            cleanStr(provider, 40),
            cleanStr(providerVoiceId, 260),
            Number(syncedAt) || 0,
            cleanStr(lastError, 260),
            cleanRole
        );
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
        const now = Date.now();
        const enabledRow = this._getSetting("patrol_enabled", "0");
        const expiresRow = this._getSetting("patrol_expires_at", "0");
        const hbRow = this._getSetting("watcher_heartbeat_at", "0");
        const byRow = this._getSetting("patrol_updated_by", "");

        let enabled = enabledRow.value === "1" || enabledRow.value === "true";
        let updatedAt = enabledRow.updatedAt || 0;
        let updatedBy = byRow.value || "";
        let expiresAt = Number(expiresRow.value) || 0;

        if (enabled && expiresAt > 0 && now >= expiresAt) {
            this._setSetting("patrol_enabled", "0", now);
            this._setSetting("patrol_expires_at", "0", now);
            this._setSetting("patrol_updated_by", "auto_timeout", now);
            enabled = false;
            expiresAt = 0;
            updatedAt = now;
            updatedBy = "auto_timeout";
        }

        const watcherLastSeenAt = Number(hbRow.value) || 0;
        const watcherOnline = watcherLastSeenAt > 0 && (now - watcherLastSeenAt) < 60_000;
        const remainingMs = enabled && expiresAt > 0 ? Math.max(0, expiresAt - now) : 0;
        const remainingMinutes = remainingMs > 0 ? Math.ceil(remainingMs / 60_000) : 0;

        return {
            enabled,
            updatedAt,
            updatedBy,
            watcherLastSeenAt,
            watcherOnline,
            expiresAt,
            remainingMinutes
        };
    }

    _readPendingWishes() {
        const rows = this.ctx.storage.sql.exec(
            `SELECT id, kid_name AS kidName, book_id AS bookId, book_title AS bookTitle,
                    page_number AS pageNumber, mode, text, target_json AS targetJson,
                    created_at AS createdAt, created_str AS createdStr
             FROM story_wishes
             WHERE status = 'pending'
             ORDER BY created_at ASC
             LIMIT 20`
        ).toArray();
        return rows.map(({ targetJson, ...rest }) => ({
            ...rest,
            target: safeParseJson(targetJson)
        }));
    }

    _readAll() {
        const rawWishes = this.ctx.storage.sql.exec(
            `SELECT id, kid_name AS kidName, book_id AS bookId, book_title AS bookTitle,
                    page_number AS pageNumber, mode, text, target_json AS targetJson,
                    instant_reply_key AS instantReplyKey, instant_reply_text AS instantReplyText,
                    status, created_at AS createdAt, created_str AS createdStr
             FROM story_wishes
             ORDER BY created_at ASC
             LIMIT 200`
        ).toArray();

        const wishes = rawWishes.map(({ targetJson, ...rest }) => ({
            ...rest,
            target: safeParseJson(targetJson)
        }));

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
        const cleanTarget = sanitizeTarget(raw.target);
        const targetJson = cleanTarget ? JSON.stringify(cleanTarget).slice(0, 1600) : "";
        const instantReplyKey = cleanStr(raw.instantReplyKey, 48);
        const instantReplyText = cleanStr(raw.instantReplyText, 600);
        const createdAt = Number(raw.createdAt) > 0 ? Math.floor(Number(raw.createdAt)) : now;
        const createdStr = cleanStr(raw.createdStr, 32) || formatBeijingTimeStr(createdAt);

        this.ctx.storage.sql.exec(
            `INSERT INTO story_wishes
                (id, kid_name, book_id, book_title, page_number, mode, text, target_json, instant_reply_key, instant_reply_text, status, created_at, created_str)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                target_json = CASE WHEN excluded.target_json != '' THEN excluded.target_json ELSE story_wishes.target_json END,
                instant_reply_key = CASE WHEN excluded.instant_reply_key != '' THEN excluded.instant_reply_key ELSE story_wishes.instant_reply_key END,
                instant_reply_text = CASE WHEN excluded.instant_reply_text != '' THEN excluded.instant_reply_text ELSE story_wishes.instant_reply_text END`,
            id, kidName, bookId, bookTitle, pageNumber, mode, text, targetJson, instantReplyKey, instantReplyText, createdAt, createdStr
        );

        this.ctx.storage.sql.exec(
            `DELETE FROM story_wishes WHERE id NOT IN (
                SELECT id FROM story_wishes ORDER BY created_at DESC LIMIT 200
            )`
        );
        return {
            id, kidName, bookId, bookTitle, pageNumber, mode, text,
            target: cleanTarget, instantReplyKey, instantReplyText, createdAt, createdStr
        };
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
                const latestPendingAt = pendingWishes.reduce((mx, w) => Math.max(mx, Number(w.createdAt) || 0), 0);
                const dispatchRequestedAt = Number(this._getSetting("dispatch_now_at", "0").value) || 0;
                return jsonResponse({
                    ok: true,
                    patrol: this._getPatrolState(),
                    pendingCount: pendingWishes.length,
                    pendingWishes,
                    latestPendingAt,
                    dispatchRequestedAt,
                    serverTime: Date.now()
                });
            }

            if (request.method === "POST" && path === "/api/mailbox/dispatch") {
                const now = Date.now();
                this._setSetting("patrol_enabled", "1", now);
                this._setSetting("patrol_updated_by", "user_dispatch", now);
                this._setSetting("patrol_expires_at", String(now + PATROL_AUTO_OFF_MS), now);
                this._setSetting("dispatch_now_at", String(now), now);
                const pendingWishes = this._readPendingWishes();
                return jsonResponse({
                    ok: true,
                    patrol: this._getPatrolState(),
                    dispatchRequestedAt: now,
                    pendingCount: pendingWishes.length,
                    serverTime: now
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
                if (body.enabled) {
                    const ttlMinutes = Math.max(10, Math.min(240, Number(body.ttlMinutes) || 60));
                    this._setSetting("patrol_expires_at", String(now + ttlMinutes * 60_000), now);
                } else {
                    this._setSetting("patrol_expires_at", "0", now);
                }
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

                // 先立刻把小豌豆的点子落盘写入 SQLite，并自动开启巡检唤醒本地零 Token 哨兵
                const savedWish = this._upsertWish({
                    ...body,
                    instantReplyKey: "",
                    instantReplyText: ""
                });

                const wakeNow = Date.now();
                this._setSetting("patrol_enabled", "1", wakeNow);
                this._setSetting("patrol_updated_by", "auto_wish", wakeNow);
                this._setSetting("patrol_expires_at", String(wakeNow + PATROL_AUTO_OFF_MS), wakeNow);
                this._setSetting("dispatch_now_at", "0", wakeNow);

                const wishTarget = savedWish?.target || sanitizeTarget(body.target);
                const pageContext = sanitizePageContext(body.pageContext);

                let replyKey = "local_fallback";
                let replyText = cleanStr(body.fallbackReplyText, 600) || buildFallbackArtistReply(text, bookTitle, wishTarget);
                let aiGenerated = false;
                let aiModel = "";
                let audioBase64 = "";

                const aiRes = await generateStoryArtistReply(this.env?.AI, {
                    text,
                    bookTitle,
                    pageNumber,
                    mode,
                    target: wishTarget,
                    pageContext,
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
                    ...savedWish,
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
                    patrol: this._getPatrolState(),
                    serverTime: Date.now()
                });
            }

            if (request.method === "POST" && path === "/api/mailbox/sync") {
                const body = await request.json().catch(() => ({}));
                if (Array.isArray(body.wishes) && body.wishes.length > 0) {
                    for (const w of body.wishes.slice(0, 50)) {
                        this._upsertWish(w);
                    }
                    if (this._readPendingWishes().length > 0) {
                        const wakeNow = Date.now();
                        this._setSetting("patrol_enabled", "1", wakeNow);
                        this._setSetting("patrol_updated_by", "auto_wish", wakeNow);
                        this._setSetting("patrol_expires_at", String(wakeNow + PATROL_AUTO_OFF_MS), wakeNow);
                    }
                }
                const { wishes, replies } = this._readAll();
                return jsonResponse({ ok: true, wishes, replies, patrol: this._getPatrolState(), serverTime: Date.now() });
            }

            if (request.method === "POST" && path === "/api/mailbox/reply") {
                if (!isAdminAuthorized(request, this.env)) {
                    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
                }
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
                const createdStr = cleanStr(body.createdStr, 32) || formatBeijingTimeStr(createdAt);

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
                    if (this._readPendingWishes().length === 0) {
                        this._setSetting("dispatch_now_at", "0", now);
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
                if (!isAdminAuthorized(request, this.env)) {
                    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
                }
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

            if (path.startsWith("/api/voice-profile")) {
                const role = sanitizeVoiceRole(url.searchParams.get("role"));

                if (request.method === "GET" && path === "/api/voice-profile") {
                    const row = this._getVoiceProfileRow(role);
                    return jsonResponse({ ok: true, profile: this._formatPublicVoiceProfile(row, role) });
                }

                if (request.method === "GET" && path === "/api/voice-profile/sample") {
                    const row = this._getVoiceProfileRow(role);
                    const hasSample = Boolean(row && cleanStr(row.sample_audio_b64, 32));
                    return jsonResponse({
                        ok: true,
                        role,
                        hasSample,
                        audioBase64: hasSample ? row.sample_audio_b64 : "",
                        sampleMime: row ? (cleanStr(row.sample_mime, 64) || "audio/wav") : "audio/wav",
                        durationMs: row ? Number(row.duration_ms) || 0 : 0,
                        sampleText: row ? cleanStr(row.sample_text, 400) : "",
                        version: row ? Number(row.version) || 1 : 0
                    });
                }

                if (request.method === "GET" && path === "/api/voice-profile/internal-raw") {
                    if (request.headers.get("X-Internal-Worker") !== "pea-internal") {
                        return jsonResponse({ ok: false, error: "forbidden" }, 403);
                    }
                    const row = this._getVoiceProfileRow(role);
                    const vc = getVoiceCloneConfig(this.env);
                    const hasSample = Boolean(row && cleanStr(row.sample_audio_b64, 32));
                    const enabled = row ? Number(row.enabled) !== 0 : Boolean(vc.overrideVoiceId);
                    return jsonResponse({
                        ok: true,
                        role,
                        hasSample,
                        sampleAudioB64: hasSample ? row.sample_audio_b64 : "",
                        sampleMime: row ? (cleanStr(row.sample_mime, 64) || "audio/wav") : "audio/wav",
                        sampleText: row ? cleanStr(row.sample_text, 400) : "",
                        enabled: (hasSample || Boolean(vc.overrideVoiceId)) ? enabled : false,
                        version: row ? Number(row.version) || 1 : 0,
                        provider: row ? cleanStr(row.provider, 40) : "",
                        providerVoiceId: row ? cleanStr(row.provider_voice_id, 260) : ""
                    });
                }

                if (request.method === "POST" && path === "/api/voice-profile/internal-sync") {
                    if (request.headers.get("X-Internal-Worker") !== "pea-internal") {
                        return jsonResponse({ ok: false, error: "forbidden" }, 403);
                    }
                    const body = await request.json().catch(() => ({}));
                    const syncRole = sanitizeVoiceRole(body.role || role);
                    this._updateVoiceSyncMetadata(syncRole, {
                        provider: body.provider || "",
                        providerVoiceId: body.providerVoiceId || "",
                        syncedAt: Number(body.syncedAt) || 0,
                        lastError: body.lastError || ""
                    });
                    return jsonResponse({ ok: true });
                }

                if (request.method === "POST" && path === "/api/voice-profile") {
                    const body = await request.json().catch(() => ({}));
                    const targetRole = sanitizeVoiceRole(body.role || role);
                    const rawB64 = String(body.audioBase64 || "").replace(/^data:audio\/[^;]+;base64,/, "").trim();
                    if (rawB64.length < 2000 || rawB64.length > 1_400_000) {
                        return jsonResponse({ ok: false, error: "invalid_sample_audio" }, 400);
                    }
                    const sampleMime = cleanStr(body.sampleMime, 64) || "audio/wav";
                    const sampleText = cleanStr(body.sampleText, 400) || "大家好，我是小豌豆！欢迎来到我的魔法故事漫画屋！";
                    const durationMs = Math.max(1500, Math.min(25000, Math.floor(Number(body.durationMs) || 10000)));
                    const prev = this._getVoiceProfileRow(targetRole);
                    const nextVersion = (prev ? Number(prev.version) || 0 : 0) + 1;
                    const now = Date.now();
                    const updatedStr = formatBeijingTimeStr(now);

                    this.ctx.storage.sql.exec(
                        `INSERT INTO voice_profiles
                            (role, sample_audio_b64, sample_mime, sample_text, duration_ms, enabled, version, provider, provider_voice_id, provider_synced_at, last_error, updated_at, updated_str)
                         VALUES (?, ?, ?, ?, ?, 1, ?, '', '', 0, '', ?, ?)
                         ON CONFLICT(role) DO UPDATE SET
                            sample_audio_b64 = excluded.sample_audio_b64,
                            sample_mime = excluded.sample_mime,
                            sample_text = excluded.sample_text,
                            duration_ms = excluded.duration_ms,
                            enabled = 1,
                            version = excluded.version,
                            provider = '',
                            provider_voice_id = '',
                            provider_synced_at = 0,
                            last_error = '',
                            updated_at = excluded.updated_at,
                            updated_str = excluded.updated_str`,
                        targetRole, rawB64, sampleMime, sampleText, durationMs, nextVersion, now, updatedStr
                    );

                    const vc = getVoiceCloneConfig(this.env);
                    if (vc.configured) {
                        try {
                            const providerVoiceId = await enrollClonedVoice(vc, {
                                sampleAudioB64: rawB64,
                                sampleMime,
                                sampleText,
                                version: nextVersion
                            });
                            this._updateVoiceSyncMetadata(targetRole, {
                                provider: vc.provider,
                                providerVoiceId,
                                syncedAt: Date.now(),
                                lastError: ""
                            });
                        } catch (err) {
                            this._updateVoiceSyncMetadata(targetRole, {
                                provider: vc.provider,
                                providerVoiceId: "",
                                syncedAt: 0,
                                lastError: err?.message || String(err)
                            });
                        }
                    }

                    const saved = this._getVoiceProfileRow(targetRole);
                    return jsonResponse({ ok: true, profile: this._formatPublicVoiceProfile(saved, targetRole) });
                }

                if (request.method === "POST" && path === "/api/voice-profile/toggle") {
                    const body = await request.json().catch(() => ({}));
                    if (typeof body.enabled !== "boolean") {
                        return jsonResponse({ ok: false, error: "invalid_enabled" }, 400);
                    }
                    const targetRole = sanitizeVoiceRole(body.role || role);
                    const vc = getVoiceCloneConfig(this.env);
                    const prev = this._getVoiceProfileRow(targetRole);
                    const now = Date.now();
                    const updatedStr = formatBeijingTimeStr(now);
                    const enabledVal = body.enabled ? 1 : 0;

                    if (!prev) {
                        if (!vc.overrideVoiceId) {
                            return jsonResponse({ ok: false, error: "voice_profile_not_found" }, 404);
                        }
                        this.ctx.storage.sql.exec(
                            `INSERT INTO voice_profiles
                                (role, sample_audio_b64, sample_mime, sample_text, duration_ms, enabled, version, provider, provider_voice_id, provider_synced_at, last_error, updated_at, updated_str)
                             VALUES (?, '', 'audio/wav', '', 0, ?, 1, ?, ?, ?, '', ?, ?)`,
                            targetRole, enabledVal, vc.provider, vc.overrideVoiceId, now, now, updatedStr
                        );
                    } else {
                        this.ctx.storage.sql.exec(
                            `UPDATE voice_profiles SET enabled = ?, updated_at = ?, updated_str = ? WHERE role = ?`,
                            enabledVal, now, updatedStr, targetRole
                        );
                    }
                    const updated = this._getVoiceProfileRow(targetRole);
                    return jsonResponse({ ok: true, profile: this._formatPublicVoiceProfile(updated, targetRole) });
                }

                if (request.method === "POST" && path === "/api/voice-profile/delete") {
                    const body = await request.json().catch(() => ({}));
                    const targetRole = sanitizeVoiceRole(body.role || role);
                    this.ctx.storage.sql.exec(`DELETE FROM voice_profiles WHERE role = ?`, targetRole);
                    return jsonResponse({ ok: true, profile: this._formatPublicVoiceProfile(null, targetRole) });
                }

                if (request.method === "POST" && path === "/api/voice-profile/test") {
                    const body = await request.json().catch(() => ({}));
                    const targetRole = sanitizeVoiceRole(body.role || role);
                    const cleanText = stripSpeechTextForTts(cleanStr(body.text, 240)) || "大家好，我是小豌豆！现在每一本故事书里都是我自己的声音啦！";
                    const row = this._getVoiceProfileRow(targetRole);
                    const vc = getVoiceCloneConfig(this.env);
                    const hasSample = Boolean(row && cleanStr(row.sample_audio_b64, 32));

                    if (!hasSample && !vc.overrideVoiceId) {
                        return jsonResponse({
                            ok: true,
                            mode: "unconfigured",
                            audioBase64: "",
                            message: "还没有录制小豌豆的声音样本哦，先按中间的录音按钮念一段吧！",
                            profile: this._formatPublicVoiceProfile(row, targetRole)
                        });
                    }
                    if (!vc.configured) {
                        return jsonResponse({
                            ok: true,
                            mode: "unconfigured",
                            audioBase64: "",
                            message: "小豌豆原声已经安全存好！还需爸爸妈妈在 Cloudflare 后台配置 VOICE_CLONE_API_KEY 密钥才能开启 AI 克隆试听哦。",
                            profile: this._formatPublicVoiceProfile(row, targetRole)
                        });
                    }
                    if (row && Number(row.enabled) === 0) {
                        return jsonResponse({
                            ok: true,
                            mode: "disabled",
                            audioBase64: "",
                            message: "当前已暂停使用专属声音，打开上面的启用开关就能试听啦。",
                            profile: this._formatPublicVoiceProfile(row, targetRole)
                        });
                    }

                    try {
                        const res = await runClonedTtsWithEnroll({
                            vcCfg: vc,
                            cleanText,
                            profile: {
                                hasSample,
                                sampleAudioB64: hasSample ? row.sample_audio_b64 : "",
                                sampleMime: row?.sample_mime || "audio/wav",
                                sampleText: row?.sample_text || "",
                                version: row ? Number(row.version) || 1 : 1,
                                provider: row?.provider || "",
                                providerVoiceId: row?.provider_voice_id || ""
                            },
                            syncFn: async (meta) => {
                                if (row) this._updateVoiceSyncMetadata(targetRole, meta);
                            }
                        });
                        const freshRow = this._getVoiceProfileRow(targetRole);
                        return jsonResponse({
                            ok: true,
                            mode: "cloned",
                            audioBase64: res.audioBase64,
                            message: `太棒啦！已用【${vc.providerLabel}】为你实时合成试听！`,
                            profile: this._formatPublicVoiceProfile(freshRow, targetRole)
                        });
                    } catch (err) {
                        const errMsg = cleanStr(err?.message || err, 260);
                        if (row) {
                            this._updateVoiceSyncMetadata(targetRole, {
                                provider: vc.provider,
                                providerVoiceId: row.provider_voice_id || "",
                                syncedAt: Number(row.provider_synced_at) || 0,
                                lastError: errMsg
                            });
                        }
                        let fallbackAudio = "";
                        try {
                            fallbackAudio = await synthesizeNeuralMp3Base64(cleanText, targetRole);
                        } catch (_) {}
                        const freshRow = this._getVoiceProfileRow(targetRole);
                        return jsonResponse({
                            ok: true,
                            mode: "fallback",
                            audioBase64: fallbackAudio,
                            message: `克隆接口暂时没有联通（${errMsg.slice(0, 70)}），先用默认声音为你播报～`,
                            profile: this._formatPublicVoiceProfile(freshRow, targetRole)
                        });
                    }
                }
            }

            return jsonResponse({ ok: false, error: "not_found" }, 404);
        } catch (err) {
            return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
        }
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // 严禁外部请求伪造 Worker 内部接口或内部头
        if (url.pathname.includes("/internal-")) {
            return jsonResponse({ ok: false, error: "forbidden" }, 403);
        }

        if (url.pathname === "/api/health" && request.method === "GET") {
            const vc = getVoiceCloneConfig(env);
            return jsonResponse({
                ok: true,
                service: "pea-story-house",
                voices: Object.keys(ROLE_NEURAL_VOICES),
                ai: Boolean(env?.AI),
                mailbox: Boolean(env?.STORY_MAILBOX),
                voiceClone: {
                    configured: vc.configured,
                    provider: vc.provider,
                    providerLabel: vc.providerLabel
                }
            });
        }

        if (url.pathname === "/api/tts") {
            if (request.method === "POST") {
                try {
                    const body = await request.json().catch(() => ({}));
                    const text = cleanStr(body.text, 600);
                    const role = cleanStr(body.role, 32) || "narrator";
                    const cleanText = stripSpeechTextForTts(text);
                    if (!cleanText) {
                        return jsonResponse({ ok: false, error: "empty_text" }, 400);
                    }

                    const edgeCache = typeof caches !== "undefined" ? caches.default : null;
                    const vcCfg = role === "pea" ? getVoiceCloneConfig(env) : null;

                    if (role === "pea" && vcCfg && vcCfg.configured && env?.STORY_MAILBOX) {
                        try {
                            const id = env.STORY_MAILBOX.idFromName("pea-story-house-mailbox-v1");
                            const stub = env.STORY_MAILBOX.get(id);
                            const rawRes = await stub.fetch("https://mailbox.internal/api/voice-profile/internal-raw?role=pea", {
                                headers: { "X-Internal-Worker": "pea-internal" }
                            });
                            const rawProfile = rawRes.ok ? await rawRes.json().catch(() => null) : null;

                            if (rawProfile && rawProfile.ok && rawProfile.enabled && (rawProfile.hasSample || vcCfg.overrideVoiceId)) {
                                const cloneHash = await sha256Hex(JSON.stringify({
                                    v: 2,
                                    source: "clone",
                                    provider: vcCfg.provider,
                                    model: vcCfg.model,
                                    voiceVersion: rawProfile.version || 0,
                                    overrideVoiceId: vcCfg.overrideVoiceId,
                                    text: cleanText
                                }));
                                const cloneCacheReq = new Request(`https://tts-cache.pea-story-house.internal/v2/${cloneHash}`, { method: "GET" });

                                if (edgeCache) {
                                    try {
                                        const cloneHit = await edgeCache.match(cloneCacheReq);
                                        if (cloneHit) {
                                            const hitText = await cloneHit.text();
                                            return new Response(hitText, {
                                                status: 200,
                                                headers: {
                                                    "Content-Type": "application/json; charset=utf-8",
                                                    "Cache-Control": "no-store, no-cache, must-revalidate",
                                                    "X-TTS-Cache": "HIT",
                                                    "X-Voice-Source": "cloned",
                                                    ...CORS_HEADERS
                                                }
                                            });
                                        }
                                    } catch (_) {}
                                }

                                const cloned = await runClonedTtsWithEnroll({
                                    vcCfg,
                                    cleanText,
                                    profile: rawProfile,
                                    syncFn: async (meta) => {
                                        await stub.fetch("https://mailbox.internal/api/voice-profile/internal-sync", {
                                            method: "POST",
                                            headers: {
                                                "Content-Type": "application/json",
                                                "X-Internal-Worker": "pea-internal"
                                            },
                                            body: JSON.stringify({ role: "pea", ...meta })
                                        }).catch(() => {});
                                    }
                                });

                                if (cloned && cloned.audioBase64) {
                                    const clonePayload = JSON.stringify({
                                        ok: true,
                                        role,
                                        voiceSource: "cloned",
                                        provider: vcCfg.provider,
                                        voiceVersion: rawProfile.version || 1,
                                        audioBase64: cloned.audioBase64
                                    });
                                    if (edgeCache) {
                                        try {
                                            const cacheResp = new Response(clonePayload, {
                                                status: 200,
                                                headers: {
                                                    "Content-Type": "application/json; charset=utf-8",
                                                    "Cache-Control": "public, max-age=604800"
                                                }
                                            });
                                            const putPromise = edgeCache.put(cloneCacheReq, cacheResp).catch(() => {});
                                            if (ctx && typeof ctx.waitUntil === "function") {
                                                ctx.waitUntil(putPromise);
                                            }
                                        } catch (_) {}
                                    }
                                    return new Response(clonePayload, {
                                        status: 200,
                                        headers: {
                                            "Content-Type": "application/json; charset=utf-8",
                                            "Cache-Control": "no-store, no-cache, must-revalidate",
                                            "X-TTS-Cache": "MISS",
                                            "X-Voice-Source": "cloned",
                                            ...CORS_HEADERS
                                        }
                                    });
                                }
                            }
                        } catch (cloneErr) {
                            try {
                                const id = env.STORY_MAILBOX.idFromName("pea-story-house-mailbox-v1");
                                const stub = env.STORY_MAILBOX.get(id);
                                const errPromise = stub.fetch("https://mailbox.internal/api/voice-profile/internal-sync", {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/json",
                                        "X-Internal-Worker": "pea-internal"
                                    },
                                    body: JSON.stringify({
                                        role: "pea",
                                        provider: vcCfg.provider,
                                        lastError: cloneErr?.message || String(cloneErr)
                                    })
                                }).catch(() => {});
                                if (ctx && typeof ctx.waitUntil === "function") {
                                    ctx.waitUntil(errPromise);
                                }
                            } catch (_) {}
                        }
                    }

                    const prof = getRoleVoiceProfile(role);
                    const cacheHash = await sha256Hex(JSON.stringify({
                        v: 1,
                        voice: prof.voice,
                        rate: prof.rate,
                        pitch: prof.pitch,
                        text: cleanText
                    }));
                    const cacheReq = new Request(`https://tts-cache.pea-story-house.internal/v1/${cacheHash}`, { method: "GET" });

                    if (edgeCache) {
                        try {
                            const hit = await edgeCache.match(cacheReq);
                            if (hit) {
                                const hitText = await hit.text();
                                return new Response(hitText, {
                                    status: 200,
                                    headers: {
                                        "Content-Type": "application/json; charset=utf-8",
                                        "Cache-Control": "no-store, no-cache, must-revalidate",
                                        "X-TTS-Cache": "HIT",
                                        "X-Voice-Source": "neural",
                                        ...CORS_HEADERS
                                    }
                                });
                            }
                        } catch (_) {}
                    }

                    const audioBase64 = await synthesizeNeuralMp3Base64(cleanText, role);
                    const payloadStr = JSON.stringify({ ok: true, role, voiceSource: "neural", audioBase64 });

                    if (edgeCache && audioBase64) {
                        try {
                            const cacheResp = new Response(payloadStr, {
                                status: 200,
                                headers: {
                                    "Content-Type": "application/json; charset=utf-8",
                                    "Cache-Control": "public, max-age=604800"
                                }
                            });
                            const putPromise = edgeCache.put(cacheReq, cacheResp).catch(() => {});
                            if (ctx && typeof ctx.waitUntil === "function") {
                                ctx.waitUntil(putPromise);
                            }
                        } catch (_) {}
                    }

                    return new Response(payloadStr, {
                        status: 200,
                        headers: {
                            "Content-Type": "application/json; charset=utf-8",
                            "Cache-Control": "no-store, no-cache, must-revalidate",
                            "X-TTS-Cache": "MISS",
                            "X-Voice-Source": "neural",
                            ...CORS_HEADERS
                        }
                    });
                } catch (err) {
                    return jsonResponse({
                        ok: false,
                        error: String(err && err.message ? err.message : err)
                    }, 503);
                }
            }
            return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
        }

        if (url.pathname.startsWith("/api/voice-profile")) {
            if (env && env.STORY_MAILBOX) {
                const fwdHeaders = new Headers(request.headers);
                fwdHeaders.delete("X-Internal-Worker");
                const cleanReq = new Request(request.url, {
                    method: request.method,
                    headers: fwdHeaders,
                    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body
                });
                const id = env.STORY_MAILBOX.idFromName("pea-story-house-mailbox-v1");
                const stub = env.STORY_MAILBOX.get(id);
                return stub.fetch(cleanReq);
            }
            return jsonResponse({ ok: false, error: "mailbox_binding_unavailable" }, 503);
        }

        if (url.pathname.startsWith("/api/mailbox")) {
            if (request.method === "POST" && url.pathname === "/api/mailbox/transcribe") {
                try {
                    const ctype = (request.headers.get("content-type") || "").toLowerCase();
                    let hints = "";
                    const rawHeaderHints = request.headers.get("x-story-hints") || "";
                    if (rawHeaderHints) {
                        try {
                            hints = decodeURIComponent(rawHeaderHints);
                        } catch (_) {
                            hints = rawHeaderHints;
                        }
                    }

                    let result;
                    if (ctype.includes("application/json")) {
                        const body = await request.json().catch(() => ({}));
                        if (!hints && body.hints) hints = body.hints;
                        result = await transcribeAudioFast(env?.AI, { audioBase64: body.audioBase64, hints });
                    } else {
                        const ab = await request.arrayBuffer();
                        result = await transcribeAudioFast(env?.AI, {
                            rawBytes: new Uint8Array(ab),
                            contentType: ctype || "audio/webm",
                            hints
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
