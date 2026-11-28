/**
 * voiceCloneMod.js - 小豌豆专属 AI 声线克隆多平台适配器（Cloudflare Workers 零依赖版）
 * 支持：
 * 1. siliconflow（硅基流动 CosyVoice2-0.5B）
 * 2. minimax（MiniMax 海螺 Speech 2.8 HD）
 * 3. fishaudio（Fish Audio S1 / 零样本声音克隆）
 */

export const SUPPORTED_PROVIDERS = {
    siliconflow: {
        id: "siliconflow",
        label: "硅基流动 SiliconFlow (CosyVoice2)",
        defaultBaseUrl: "https://api.siliconflow.cn",
        defaultModel: "FunAudioLLM/CosyVoice2-0.5B"
    },
    minimax: {
        id: "minimax",
        label: "MiniMax 海螺语音 (Speech 2.8)",
        defaultBaseUrl: "https://api.minimaxi.com",
        defaultModel: "speech-2.8-hd"
    },
    fishaudio: {
        id: "fishaudio",
        label: "Fish Audio (S1 零样本克隆)",
        defaultBaseUrl: "https://api.fish.audio",
        defaultModel: "s1"
    }
};

export class VoiceNotFoundError extends Error {
    constructor(message = "cloned_voice_not_found") {
        super(message);
        this.name = "VoiceNotFoundError";
    }
}

function cleanStr(val, maxLen = 500) {
    if (val === undefined || val === null) return "";
    return String(val).trim().slice(0, maxLen);
}

function stripDataUrlPrefix(b64) {
    return String(b64 || "").replace(/^data:audio\/[^;]+;base64,/, "").trim();
}

export function uint8ToBase64(u8) {
    const arr = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8 || 0);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < arr.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

export function base64ToUint8Array(b64) {
    const clean = stripDataUrlPrefix(b64);
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function hexToBase64(hexStr) {
    const clean = String(hexStr || "").replace(/[^0-9a-fA-F]/g, "");
    if (!clean || clean.length % 2 !== 0) return "";
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
        bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
    }
    return uint8ToBase64(bytes);
}

function normalizeProviderId(raw) {
    const s = cleanStr(raw, 40).toLowerCase();
    if (!s || s === "silicon" || s === "siliconflow" || s === "cosyvoice") return "siliconflow";
    if (s === "minimax" || s === "hailuo") return "minimax";
    if (s === "fish" || s === "fishaudio" || s === "fish_audio") return "fishaudio";
    return SUPPORTED_PROVIDERS[s] ? s : "siliconflow";
}

export function getVoiceCloneConfig(env = {}) {
    const provider = normalizeProviderId(env?.VOICE_CLONE_PROVIDER);
    const spec = SUPPORTED_PROVIDERS[provider] || SUPPORTED_PROVIDERS.siliconflow;
    const apiKey = cleanStr(env?.VOICE_CLONE_API_KEY, 400);
    const rawBase = cleanStr(env?.VOICE_CLONE_BASE_URL, 260).replace(/\/+$/, "");
    const baseUrl = rawBase || spec.defaultBaseUrl;
    const model = cleanStr(env?.VOICE_CLONE_MODEL, 120) || spec.defaultModel;
    const overrideVoiceId = cleanStr(env?.VOICE_CLONE_VOICE_ID, 240);

    return {
        configured: Boolean(apiKey),
        provider,
        providerLabel: spec.label,
        apiKey,
        baseUrl,
        model,
        overrideVoiceId
    };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
        return await fetch(url, {
            ...options,
            signal: ctrl ? ctrl.signal : undefined
        });
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function readErrorSummary(res) {
    try {
        const text = await res.text();
        return text.slice(0, 220);
    } catch (_) {
        return `http_${res.status}`;
    }
}

function isVoiceMissingSignal(code, message = "") {
    const msg = String(message || "").toLowerCase();
    const num = Number(code);
    if (num === 2013 || num === 1004 || num === 1026) return true;
    return /(voice|speaker|reference).*?(not\s*found|invalid|not\s*exist|expired|missing|deleted)/i.test(msg);
}

/**
 * 在配置的声音克隆平台注册/绑定小豌豆声音样本，返回 providerVoiceId
 */
export async function enrollClonedVoice(cfg, {
    sampleAudioB64 = "",
    sampleMime = "audio/wav",
    sampleText = "",
    version = 1
} = {}) {
    if (!cfg || !cfg.configured) {
        throw new Error("voice_clone_not_configured");
    }
    if (cfg.overrideVoiceId) {
        return cfg.overrideVoiceId;
    }

    const cleanB64 = stripDataUrlPrefix(sampleAudioB64);
    if (!cleanB64) {
        throw new Error("empty_voice_sample");
    }
    const safeMime = cleanStr(sampleMime, 64) || "audio/wav";
    const transcript = cleanStr(sampleText, 400) || "大家好，我是小豌豆！欢迎来到我的魔法故事漫画屋！";
    const verNum = Math.max(1, Number(version) || 1);

    if (cfg.provider === "siliconflow") {
        const res = await fetchWithTimeout(`${cfg.baseUrl}/v1/uploads/audio/voice`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${cfg.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: cfg.model,
                customName: `pea_voice_v${verNum}`,
                audio: `data:${safeMime};base64,${cleanB64}`,
                text: transcript
            })
        }, 18000);

        if (!res.ok) {
            const detail = await readErrorSummary(res);
            throw new Error(`siliconflow_enroll_${res.status}: ${detail}`);
        }
        const data = await res.json().catch(() => ({}));
        const uri = cleanStr(data?.uri, 260);
        if (!uri) {
            throw new Error("siliconflow_enroll_missing_uri");
        }
        return uri;
    }

    if (cfg.provider === "minimax") {
        const bytes = base64ToUint8Array(cleanB64);
        const ext = safeMime.includes("mp3") || safeMime.includes("mpeg")
            ? "mp3"
            : (safeMime.includes("mp4") || safeMime.includes("m4a") ? "m4a" : "wav");
        const fd = new FormData();
        fd.append("purpose", "voice_clone");
        fd.append("file", new Blob([bytes], { type: safeMime }), `pea_sample_v${verNum}.${ext}`);

        const uploadRes = await fetchWithTimeout(`${cfg.baseUrl}/v1/files/upload`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${cfg.apiKey}`
            },
            body: fd
        }, 20000);

        if (!uploadRes.ok) {
            const detail = await readErrorSummary(uploadRes);
            throw new Error(`minimax_upload_${uploadRes.status}: ${detail}`);
        }
        const uploadData = await uploadRes.json().catch(() => ({}));
        const uploadStatus = Number(uploadData?.base_resp?.status_code ?? 0);
        const fileId = uploadData?.file?.file_id;
        if (uploadStatus !== 0 || !fileId) {
            throw new Error(`minimax_upload_err_${uploadStatus}: ${uploadData?.base_resp?.status_msg || "no_file_id"}`);
        }

        const voiceId = `pea_story_v${verNum}_${Date.now().toString(36).slice(-5)}`;
        const cloneRes = await fetchWithTimeout(`${cfg.baseUrl}/v1/voice_clone`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${cfg.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                file_id: fileId,
                voice_id: voiceId,
                need_noise_reduction: true,
                need_volume_normalization: true
            })
        }, 18000);

        if (!cloneRes.ok) {
            const detail = await readErrorSummary(cloneRes);
            throw new Error(`minimax_clone_${cloneRes.status}: ${detail}`);
        }
        const cloneData = await cloneRes.json().catch(() => ({}));
        const cloneStatus = Number(cloneData?.base_resp?.status_code ?? 0);
        if (cloneStatus !== 0) {
            throw new Error(`minimax_clone_err_${cloneStatus}: ${cloneData?.base_resp?.status_msg || "clone_failed"}`);
        }
        return voiceId;
    }

    if (cfg.provider === "fishaudio") {
        // Fish Audio 支持在每次 /v1/tts 请求内直传 references 做零样本克隆
        return `zeroshot_sample_v${verNum}`;
    }

    throw new Error(`unsupported_provider_${cfg.provider}`);
}

/**
 * 使用小豌豆专属克隆音色合成中文台词 MP3（返回 Base64 audio/mpeg）
 */
export async function synthesizeClonedSpeech(cfg, {
    text,
    providerVoiceId = "",
    sampleAudioB64 = "",
    sampleText = ""
} = {}) {
    if (!cfg || !cfg.configured) {
        throw new Error("voice_clone_not_configured");
    }
    const cleanText = cleanStr(text, 600);
    if (!cleanText) {
        throw new Error("empty_tts_text");
    }
    const voiceId = cleanStr(cfg.overrideVoiceId || providerVoiceId, 260);
    if (!voiceId) {
        throw new VoiceNotFoundError("missing_provider_voice_id");
    }

    if (cfg.provider === "siliconflow") {
        const res = await fetchWithTimeout(`${cfg.baseUrl}/v1/audio/speech`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${cfg.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: cfg.model,
                input: cleanText,
                voice: voiceId,
                response_format: "mp3",
                sample_rate: 32000,
                speed: 1.0,
                gain: 0.0
            })
        }, 18000);

        if (!res.ok) {
            const detail = await readErrorSummary(res);
            if (res.status === 404 || isVoiceMissingSignal(res.status, detail)) {
                throw new VoiceNotFoundError(detail);
            }
            throw new Error(`siliconflow_tts_${res.status}: ${detail}`);
        }

        const ab = await res.arrayBuffer();
        if (!ab || ab.byteLength < 64) {
            throw new Error("siliconflow_tts_empty_audio");
        }
        return { audioBase64: uint8ToBase64(new Uint8Array(ab)), contentType: "audio/mpeg" };
    }

    if (cfg.provider === "minimax") {
        const res = await fetchWithTimeout(`${cfg.baseUrl}/v1/t2a_v2`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${cfg.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: cfg.model,
                text: cleanText,
                stream: false,
                output_format: "hex",
                voice_setting: {
                    voice_id: voiceId,
                    speed: 1.0,
                    vol: 1.0,
                    pitch: 0
                },
                audio_setting: {
                    sample_rate: 32000,
                    bitrate: 128000,
                    format: "mp3",
                    channel: 1
                }
            })
        }, 18000);

        if (!res.ok) {
            const detail = await readErrorSummary(res);
            if (res.status === 404 || isVoiceMissingSignal(res.status, detail)) {
                throw new VoiceNotFoundError(detail);
            }
            throw new Error(`minimax_tts_${res.status}: ${detail}`);
        }

        const data = await res.json().catch(() => ({}));
        const statusCode = Number(data?.base_resp?.status_code ?? 0);
        const statusMsg = String(data?.base_resp?.status_msg || "");
        if (statusCode !== 0) {
            if (isVoiceMissingSignal(statusCode, statusMsg)) {
                throw new VoiceNotFoundError(`minimax_${statusCode}: ${statusMsg}`);
            }
            throw new Error(`minimax_tts_err_${statusCode}: ${statusMsg}`);
        }

        const hexAudio = cleanStr(data?.data?.audio, 2_500_000);
        const b64 = hexToBase64(hexAudio);
        if (!b64 || b64.length < 64) {
            throw new Error("minimax_tts_empty_audio");
        }
        return { audioBase64: b64, contentType: "audio/mpeg" };
    }

    if (cfg.provider === "fishaudio") {
        const useInlineZeroshot = voiceId.startsWith("zeroshot_");
        const cleanSample = stripDataUrlPrefix(sampleAudioB64);
        if (useInlineZeroshot && !cleanSample) {
            throw new VoiceNotFoundError("fishaudio_missing_sample");
        }

        const payload = useInlineZeroshot
            ? {
                text: cleanText,
                format: "mp3",
                references: [
                    {
                        audio: cleanSample,
                        text: cleanStr(sampleText, 400) || "大家好，我是小豌豆！欢迎来到我的魔法故事漫画屋！"
                    }
                ]
            }
            : {
                text: cleanText,
                format: "mp3",
                reference_id: voiceId
            };

        const res = await fetchWithTimeout(`${cfg.baseUrl}/v1/tts`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${cfg.apiKey}`,
                "Content-Type": "application/json",
                "model": cfg.model
            },
            body: JSON.stringify(payload)
        }, 18000);

        if (!res.ok) {
            const detail = await readErrorSummary(res);
            if (res.status === 404 || isVoiceMissingSignal(res.status, detail)) {
                throw new VoiceNotFoundError(detail);
            }
            throw new Error(`fishaudio_tts_${res.status}: ${detail}`);
        }

        const ab = await res.arrayBuffer();
        if (!ab || ab.byteLength < 64) {
            throw new Error("fishaudio_tts_empty_audio");
        }
        return { audioBase64: uint8ToBase64(new Uint8Array(ab)), contentType: "audio/mpeg" };
    }

    throw new Error(`unsupported_provider_${cfg.provider}`);
}
