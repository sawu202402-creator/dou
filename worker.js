/**
 * worker.js - 《🐰 小豌豆魔法故事漫画屋》Cloudflare Worker 服务端入口
 * 职责：
 * 1. /api/tts：复用 Edge Neural TTS（edgeTtsMod.js），为绘本旁白、漫画多角色气泡与热刷新播报提供实时真人神经网络语音 MP3；
 * 2. /api/health：健康检查与可用声线列表；
 * 3. 其余静态资源交由 Cloudflare Assets 分发，并对 /version.json 及 books 下的 *.json 强制禁用边缘缓存，确保 iPad 右屏 3 秒热刷新零延迟。
 */
import { ROLE_NEURAL_VOICES, synthesizeNeuralMp3Base64 } from "./edgeTtsMod.js";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};

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
                voices: Object.keys(ROLE_NEURAL_VOICES)
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

        if (env && env.ASSETS) {
            const assetResp = await env.ASSETS.fetch(request);
            // 对 version.json、books/manifest.json 及 book.json 强制禁止浏览器与 CDN 缓存，保证热刷新秒级生效
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
