/**
 * audioEngine.js - 多角色真人神经网络语音播放引擎（适配 iPadOS Safari 与无头浏览器自检）
 * 1. 优先请求 /api/tts 实时合成 Edge Neural TTS MP3；
 * 2. 手势内同步解锁 WebAudio 与单例 HTMLAudio，保障异步回调及全书连播在 iPad Safari 稳定发声；
 * 3. 160 条 LRU 内存缓存 + 并发去重 + 页面预热；
 * 4. 离线或后端不可用时平滑降级到浏览器本地 speechSynthesis。
 */

const ROLE_LOCAL_FALLBACK = {
    narrator:      { rate: 0.94, pitch: 1.04, male: false },
    system_notice: { rate: 0.98, pitch: 1.08, male: false },
    pea:           { rate: 1.02, pitch: 1.15, male: false },
    bunny:         { rate: 1.06, pitch: 1.22, male: false },
    bear:          { rate: 0.88, pitch: 0.90, male: true },
    star_boy:      { rate: 1.05, pitch: 1.12, male: true },
    prince:        { rate: 0.98, pitch: 0.98, male: true },
    grandpa:       { rate: 0.86, pitch: 0.82, male: true },
    fairy:         { rate: 1.00, pitch: 1.14, male: false },
    cat:           { rate: 1.05, pitch: 1.20, male: false }
};

export function cleanTextForTts(raw) {
    if (!raw) return '';
    return String(raw)
        .replace(/<[^>]+>/g, '')
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
        .replace(/[✦✧★☆♪♫【】]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 580);
}

function base64ToArrayBuffer(b64) {
    const clean = String(b64 || '').replace(/^data:audio\/[^;]+;base64,/, '');
    const binary = atob(clean);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

function detectMimeFromBase64(b64) {
    const clean = String(b64 || '').trim();
    if (clean.startsWith('UklGR')) return 'audio/wav';
    if (clean.startsWith('T2dnUw')) return 'audio/ogg';
    return 'audio/mpeg';
}

export class StoryAudioEngine {
    constructor({ onStateChange } = {}) {
        this.muted = false;
        this.isSpeaking = false;
        this.lastPlaybackMode = 'idle';
        this.onStateChange = typeof onStateChange === 'function' ? onStateChange : () => {};

        this._audioCtx = null;
        this._activeBufferSrc = null;
        this._activeHtmlAudio = null;
        this._sharedHtmlAudio = null;
        this._sharedAudioUnlocked = false;
        this._warmedUp = false;

        this._speakToken = 0;
        this._activeResolve = null;
        this._activeFallbackTimer = null;
        this._ttsMemCache = new Map();
        this._inflightTtsMap = new Map();
        this._cloudTtsUnavailable = false;
        this._pendingGesturePlay = null;

        this._zhFemaleVoice = null;
        this._zhMaleVoice = null;
        this._initLocalVoices();
        this._bindFirstGestureWarmup();
    }

    _notify() {
        this.onStateChange({
            muted: this.muted,
            isSpeaking: this.isSpeaking,
            lastPlaybackMode: this.lastPlaybackMode,
            hasPendingGesturePlay: Boolean(this._pendingGesturePlay)
        });
    }

    _shouldUseCloudTts() {
        if (typeof window === 'undefined' || typeof fetch !== 'function') return false;
        if (window.__DISABLE_CLOUD_TTS === true || this._cloudTtsUnavailable) return false;
        return window.location.protocol === 'https:' || window.location.protocol === 'http:';
    }

    _initLocalVoices() {
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
        const pick = () => {
            try {
                const voices = window.speechSynthesis.getVoices() || [];
                const zhVoices = voices.filter(v => v.lang && /^zh/i.test(v.lang));
                this._zhFemaleVoice =
                    zhVoices.find(v => /Xiaoxiao|Xiaoyi|Tingting|Ting-Ting|Meijia|Google 普通话/i.test(v.name)) ||
                    zhVoices[0] ||
                    null;
                this._zhMaleVoice =
                    zhVoices.find(v => /Yunxi|Yunxia|Yunjian|Kangkang|Sin-ji/i.test(v.name)) ||
                    this._zhFemaleVoice;
            } catch (_) {}
        };
        pick();
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = pick;
        }
    }

    unlockInGesture() {
        if (typeof window === 'undefined') return;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) {
                if (!this._audioCtx) this._audioCtx = new Ctx();
                if (this._audioCtx.state === 'suspended') {
                    this._audioCtx.resume().catch(() => {});
                }
                const silentBuf = this._audioCtx.createBuffer(1, 1, 22050);
                const src = this._audioCtx.createBufferSource();
                src.buffer = silentBuf;
                src.connect(this._audioCtx.destination);
                src.start(0);
            }
        } catch (_) {}

        try {
            if (!this._sharedAudioUnlocked && typeof Audio !== 'undefined') {
                if (!this._sharedHtmlAudio) {
                    this._sharedHtmlAudio = new Audio();
                    this._sharedHtmlAudio.preload = 'auto';
                    this._sharedHtmlAudio.setAttribute('playsinline', 'true');
                }
                if (!this._activeHtmlAudio) {
                    this._sharedHtmlAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
                    const p = this._sharedHtmlAudio.play();
                    if (p && typeof p.then === 'function') {
                        p.then(() => {
                            this._sharedAudioUnlocked = true;
                            if (!this._activeHtmlAudio) {
                                try { this._sharedHtmlAudio.pause(); } catch (_) {}
                            }
                        }).catch(() => {});
                    }
                }
            }
        } catch (_) {}

        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            try { window.speechSynthesis.resume(); } catch (_) {}
        }
    }

    _bindFirstGestureWarmup() {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        const onGesture = () => {
            this.unlockInGesture();
            if (!this._warmedUp) {
                this._warmedUp = true;
                this._initLocalVoices();
            }
            if (this._pendingGesturePlay && !this.muted) {
                const pending = this._pendingGesturePlay;
                this._pendingGesturePlay = null;
                this.speak(pending.text, pending.role, pending.callbacks).catch(() => {});
            }
        };
        window.addEventListener('pointerdown', onGesture, true);
        window.addEventListener('touchstart', onGesture, true);
        window.addEventListener('keydown', onGesture, true);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && 'speechSynthesis' in window) {
                try { window.speechSynthesis.resume(); } catch (_) {}
            }
        });
    }

    setMuted(flag) {
        this.muted = Boolean(flag);
        if (this.muted) {
            this._pendingGesturePlay = null;
            this.stop();
        } else {
            this._notify();
        }
    }

    _clearTimers() {
        if (this._activeFallbackTimer) {
            clearTimeout(this._activeFallbackTimer);
            this._activeFallbackTimer = null;
        }
    }

    _stopCurrentAudioNodes() {
        this._clearTimers();
        if (this._activeBufferSrc) {
            try {
                this._activeBufferSrc.onended = null;
                this._activeBufferSrc.stop(0);
                this._activeBufferSrc.disconnect();
            } catch (_) {}
            this._activeBufferSrc = null;
        }
        if (this._activeHtmlAudio) {
            try {
                this._activeHtmlAudio.onended = null;
                this._activeHtmlAudio.onerror = null;
                this._activeHtmlAudio.pause();
            } catch (_) {}
            this._activeHtmlAudio = null;
        }
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            try { window.speechSynthesis.cancel(); } catch (_) {}
        }
    }

    stop() {
        this._speakToken++;
        this._stopCurrentAudioNodes();
        this.isSpeaking = false;
        if (this._activeResolve) {
            const resolvePrev = this._activeResolve;
            this._activeResolve = null;
            resolvePrev({ ok: true, mode: this.lastPlaybackMode, cancelled: true });
        }
        this._notify();
    }

    async _fetchNeuralTtsBase64(cleanText, role = 'narrator') {
        if (!cleanText || !this._shouldUseCloudTts()) return '';
        const cacheKey = `${role}::${cleanText}`;
        if (this._ttsMemCache.has(cacheKey)) {
            return this._ttsMemCache.get(cacheKey);
        }
        if (this._inflightTtsMap.has(cacheKey)) {
            return this._inflightTtsMap.get(cacheKey);
        }

        const reqPromise = (async () => {
            try {
                const res = await fetch('/api/tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: cleanText, role })
                });
                if (res.status === 404 || res.status === 405 || res.status === 501) {
                    this._cloudTtsUnavailable = true;
                    return '';
                }
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.ok && data.audioBase64) {
                        if (this._ttsMemCache.size >= 160) {
                            const oldest = this._ttsMemCache.keys().next().value;
                            if (oldest !== undefined) this._ttsMemCache.delete(oldest);
                        }
                        this._ttsMemCache.set(cacheKey, data.audioBase64);
                        return data.audioBase64;
                    }
                }
            } catch (_) {}
            return '';
        })();

        this._inflightTtsMap.set(cacheKey, reqPromise);
        try {
            return await reqPromise;
        } finally {
            this._inflightTtsMap.delete(cacheKey);
        }
    }

    prefetch(text, role = 'narrator') {
        if (this.muted || !text || !this._shouldUseCloudTts()) return;
        const cleanText = cleanTextForTts(text);
        if (!cleanText) return;
        this._fetchNeuralTtsBase64(cleanText, role).catch(() => {});
    }

    async _playBase64AndAwaitEnd(b64, token) {
        if (!b64 || token !== this._speakToken || this.muted) {
            return { played: false, reason: 'cancelled' };
        }

        // 1. 优先用已手势解锁的 WebAudio 解码播放（完全绕过 iPadOS Safari 异步自动播放限制）
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) {
                if (!this._audioCtx) this._audioCtx = new Ctx();
                if (this._audioCtx.state === 'suspended') {
                    await Promise.race([
                        this._audioCtx.resume().catch(() => {}),
                        new Promise(r => setTimeout(r, 150))
                    ]);
                }
                if (this._audioCtx.state === 'running') {
                    const ab = base64ToArrayBuffer(b64);
                    if (ab && ab.byteLength > 40 && token === this._speakToken) {
                        const decoded = await this._audioCtx.decodeAudioData(ab.slice(0));
                        if (token !== this._speakToken || this.muted) {
                            return { played: false, reason: 'cancelled' };
                        }
                        const durationMs = Math.max(80, Math.ceil(decoded.duration * 1000));
                        return await new Promise((resolve) => {
                            const src = this._audioCtx.createBufferSource();
                            src.buffer = decoded;
                            src.connect(this._audioCtx.destination);
                            this._activeBufferSrc = src;
                            this.lastPlaybackMode = 'neural-mp3';
                            let settled = false;
                            const done = () => {
                                if (settled) return;
                                settled = true;
                                this._clearTimers();
                                if (this._activeBufferSrc === src) this._activeBufferSrc = null;
                                resolve({ played: true, mode: 'neural-mp3' });
                            };
                            src.onended = done;
                            this._activeFallbackTimer = setTimeout(done, durationMs + 600);
                            src.start(0);
                        });
                    }
                }
            }
        } catch (_) {}

        // 2. 次选复用单例 HTMLAudioElement
        try {
            const audio = this._sharedHtmlAudio || (typeof Audio !== 'undefined' ? new Audio() : null);
            if (audio && token === this._speakToken && !this.muted) {
                const mime = detectMimeFromBase64(b64);
                audio.setAttribute('playsinline', 'true');
                audio.src = `data:${mime};base64,${b64}`;
                this._activeHtmlAudio = audio;
                return await new Promise((resolve) => {
                    let settled = false;
                    const done = (ok) => {
                        if (settled) return;
                        settled = true;
                        this._clearTimers();
                        if (this._activeHtmlAudio === audio) this._activeHtmlAudio = null;
                        resolve({ played: ok, mode: ok ? 'neural-mp3' : 'blocked' });
                    };
                    audio.onended = () => done(true);
                    audio.onerror = () => done(false);
                    this._activeFallbackTimer = setTimeout(() => done(true), 20000);
                    const playPromise = audio.play();
                    if (playPromise && typeof playPromise.then === 'function') {
                        playPromise.then(() => {
                            this.lastPlaybackMode = 'neural-mp3';
                        }).catch(() => done(false));
                    }
                });
            }
        } catch (_) {
            this._activeHtmlAudio = null;
        }

        return { played: false, reason: 'autoplay_blocked' };
    }

    _playLocalSpeechAndAwaitEnd(cleanText, role, token) {
        if (this.muted || !cleanText || token !== this._speakToken) {
            return Promise.resolve({ played: false, mode: 'idle' });
        }
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
            return Promise.resolve({ played: false, mode: 'idle' });
        }

        const profile = ROLE_LOCAL_FALLBACK[role] || ROLE_LOCAL_FALLBACK.narrator;
        return new Promise((resolve) => {
            try {
                if (!this._zhFemaleVoice) this._initLocalVoices();
                window.speechSynthesis.cancel();
                window.speechSynthesis.resume();
                const utter = new SpeechSynthesisUtterance(cleanText);
                utter.lang = 'zh-CN';
                const chosen = profile.male ? this._zhMaleVoice : this._zhFemaleVoice;
                if (chosen) utter.voice = chosen;
                utter.rate = profile.rate;
                utter.pitch = profile.pitch;
                utter.volume = 1.0;

                let settled = false;
                const done = (ok) => {
                    if (settled) return;
                    settled = true;
                    this._clearTimers();
                    resolve({ played: ok, mode: 'speechSynthesis' });
                };
                utter.onend = () => done(true);
                utter.onerror = () => done(false);
                const approxMs = Math.max(1200, Math.min(25000, cleanText.length * 240));
                this._activeFallbackTimer = setTimeout(() => done(true), approxMs);
                this.lastPlaybackMode = 'speechSynthesis';
                window.speechSynthesis.speak(utter);
            } catch (_) {
                resolve({ played: false, mode: 'idle' });
            }
        });
    }

    /**
     * 朗读一段台词/旁白，并在播放结束或被打断时安全 resolve
     */
    async speak(rawText, role = 'narrator', callbacks = {}) {
        const cleanText = cleanTextForTts(rawText);
        if (!cleanText || this.muted) {
            return { ok: false, mode: 'idle', cancelled: false };
        }

        this.stop();
        const token = ++this._speakToken;
        this.isSpeaking = true;
        this._pendingGesturePlay = null;
        this._notify();
        if (typeof callbacks.onStart === 'function') {
            try { callbacks.onStart(); } catch (_) {}
        }

        const finishPromise = new Promise((resolve) => {
            this._activeResolve = resolve;
        });

        const finalize = (result) => {
            if (token === this._speakToken) {
                this.isSpeaking = false;
                if (this._activeResolve) {
                    const resFn = this._activeResolve;
                    this._activeResolve = null;
                    resFn(result);
                }
                this._notify();
                if (typeof callbacks.onEnd === 'function') {
                    try { callbacks.onEnd(result); } catch (_) {}
                }
            }
        };

        (async () => {
            try {
                const b64 = await this._fetchNeuralTtsBase64(cleanText, role);
                if (token !== this._speakToken || this.muted) {
                    finalize({ ok: true, mode: this.lastPlaybackMode, cancelled: true });
                    return;
                }

                if (b64) {
                    const cloudRes = await this._playBase64AndAwaitEnd(b64, token);
                    if (token !== this._speakToken || this.muted) {
                        finalize({ ok: true, mode: this.lastPlaybackMode, cancelled: true });
                        return;
                    }
                    if (cloudRes.played) {
                        finalize({ ok: true, mode: cloudRes.mode, cancelled: false });
                        return;
                    }
                    // 若首次加载尚未点击屏幕被 Safari 拦截，暂存待手势触发，同时尝试本地语音
                    if (cloudRes.reason === 'autoplay_blocked') {
                        this._pendingGesturePlay = { text: cleanText, role, callbacks: {} };
                    }
                }

                const localRes = await this._playLocalSpeechAndAwaitEnd(cleanText, role, token);
                finalize({
                    ok: Boolean(localRes.played),
                    mode: localRes.mode || 'idle',
                    cancelled: token !== this._speakToken
                });
            } catch (_) {
                finalize({ ok: false, mode: 'idle', cancelled: false });
            }
        })();

        return finishPromise;
    }

    /**
     * 直接播放服务端随请求返回的音频 Base64；若缺失或受阻则自动降级到 speak()
     */
    async playBase64Audio(b64, fallbackText = '', role = 'narrator', callbacks = {}) {
        const cleanB64 = String(b64 || '').trim();
        const cleanFallback = cleanTextForTts(fallbackText);
        if (this.muted) {
            return { ok: false, mode: 'idle', cancelled: false };
        }
        if (!cleanB64) {
            return cleanFallback ? this.speak(cleanFallback, role, callbacks) : { ok: false, mode: 'idle', cancelled: false };
        }

        if (cleanFallback) {
            this._ttsMemCache.set(`${role}::${cleanFallback}`, cleanB64);
        }

        this.stop();
        const token = ++this._speakToken;
        this.isSpeaking = true;
        this._pendingGesturePlay = null;
        this._notify();
        if (typeof callbacks.onStart === 'function') {
            try { callbacks.onStart(); } catch (_) {}
        }

        const finishPromise = new Promise((resolve) => {
            this._activeResolve = resolve;
        });

        const finalize = (result) => {
            if (token === this._speakToken) {
                this.isSpeaking = false;
                if (this._activeResolve) {
                    const resFn = this._activeResolve;
                    this._activeResolve = null;
                    resFn(result);
                }
                this._notify();
                if (typeof callbacks.onEnd === 'function') {
                    try { callbacks.onEnd(result); } catch (_) {}
                }
            }
        };

        (async () => {
            try {
                const cloudRes = await this._playBase64AndAwaitEnd(cleanB64, token);
                if (token !== this._speakToken || this.muted) {
                    finalize({ ok: true, mode: this.lastPlaybackMode, cancelled: true });
                    return;
                }
                if (cloudRes.played) {
                    finalize({ ok: true, mode: cloudRes.mode, cancelled: false });
                    return;
                }
                if (cleanFallback) {
                    const localRes = await this._playLocalSpeechAndAwaitEnd(cleanFallback, role, token);
                    finalize({
                        ok: Boolean(localRes.played),
                        mode: localRes.mode || 'idle',
                        cancelled: token !== this._speakToken
                    });
                    return;
                }
                finalize({ ok: false, mode: 'idle', cancelled: false });
            } catch (_) {
                finalize({ ok: false, mode: 'idle', cancelled: false });
            }
        })();

        return finishPromise;
    }
}
