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
    if (clean.startsWith('AAAA')) return 'audio/mp4';
    return 'audio/mpeg';
}

const TTS_DISK_CACHE_NAME = 'pea-story-tts-v2';

function hashTextKey(str) {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ (ch + i), 0x85ebca6b) >>> 0;
    }
    return `${h1.toString(36)}_${h2.toString(36)}_${s.length}`;
}

export class StoryAudioEngine {
    constructor({ onStateChange, playbackRate = 1.0 } = {}) {
        this.muted = false;
        this.isSpeaking = false;
        this.lastPlaybackMode = 'idle';
        this.playbackRate = Math.max(0.75, Math.min(1.25, Number(playbackRate) || 1.0));
        this.onStateChange = typeof onStateChange === 'function' ? onStateChange : () => {};

        this._audioCtx = null;
        this._activeBufferSrc = null;
        this._activeHtmlAudio = null;
        this._activeObjectUrl = null;
        this._sharedHtmlAudio = null;
        this._sharedAudioUnlocked = false;
        this._warmedUp = false;

        this._speakToken = 0;
        this._activeResolve = null;
        this._activeFallbackTimer = null;
        this._ttsMemCache = new Map();
        this._inflightTtsMap = new Map();
        this._cacheEpoch = 0;
        this._voiceSig = 'default';
        this._voiceSigMap = new Map();
        this._voiceProfilesLoaded = false;
        this._cloudTtsUnavailable = false;
        this._pendingGesturePlay = null;
        this._currentSpeakText = '';
        this._currentSpeakAt = 0;
        this._lastGestureAt = 0;

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
            playbackRate: this.playbackRate,
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
        const onGesture = (ev) => {
            const now = Date.now();
            if (now - this._lastGestureAt < 120) return;
            this._lastGestureAt = now;

            this.unlockInGesture();
            if (!this._warmedUp) {
                this._warmedUp = true;
                this._initLocalVoices();
            }
            if (this._pendingGesturePlay && !this.muted) {
                const pending = this._pendingGesturePlay;
                this._pendingGesturePlay = null;
                if (pending.expiresAt && now > pending.expiresAt) return;
                const target = ev?.target;
                if (target && typeof target.closest === 'function' && target.closest('button, [role="button"], a')) {
                    return;
                }
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

    setPlaybackRate(rate) {
        const next = Math.max(0.75, Math.min(1.25, Number(rate) || 1.0));
        if (Math.abs(next - this.playbackRate) < 0.001) return;
        this.playbackRate = next;
        this._notify();
    }

    setVoiceSignature(sig = 'default') {
        const nextSig = String(sig || 'default').trim() || 'default';
        const nextObj = {};
        for (const [k, v] of this._voiceSigMap.entries()) {
            if (k !== 'pea' && v && v !== 'default') nextObj[k] = v;
        }
        if (nextSig !== 'default') nextObj.pea = nextSig;
        this.setVoiceSignatures(nextObj, { loaded: this._voiceProfilesLoaded });
    }

    setVoiceSignatures(sigObj = {}, { loaded = true } = {}) {
        if (loaded) this._voiceProfilesLoaded = true;
        const nextMap = new Map();
        if (sigObj && typeof sigObj === 'object') {
            for (const [rawId, rawSig] of Object.entries(sigObj)) {
                const speakerId = String(rawId || '').trim();
                const sig = String(rawSig || '').trim();
                if (speakerId && sig && sig !== 'default') {
                    nextMap.set(speakerId, sig);
                }
            }
        }

        const changedIds = new Set();
        for (const [k, v] of this._voiceSigMap.entries()) {
            if (nextMap.get(k) !== v) changedIds.add(k);
        }
        for (const [k, v] of nextMap.entries()) {
            if (this._voiceSigMap.get(k) !== v) changedIds.add(k);
        }

        this._voiceSigMap = nextMap;
        this._voiceSig = nextMap.get('pea') || 'default';

        if (changedIds.size > 0) {
            const evict = (map) => {
                for (const key of Array.from(map.keys())) {
                    for (const cid of changedIds) {
                        if (key.startsWith(`cloned[${cid}@`) || (cid === 'pea' && key.startsWith('pea['))) {
                            map.delete(key);
                            break;
                        }
                    }
                }
            };
            evict(this._ttsMemCache);
            evict(this._inflightTtsMap);
        }
    }

    _resolveSpeakerSig(role = 'narrator', voiceProfileId = '') {
        const speakerId = String(voiceProfileId || (role === 'pea' ? 'pea' : '')).trim();
        const sig = speakerId ? (this._voiceSigMap.get(speakerId) || 'default') : 'default';
        return { speakerId, sig };
    }

    _buildCacheKey(role = 'narrator', cleanText = '', voiceProfileId = '') {
        const { speakerId, sig } = this._resolveSpeakerSig(role, voiceProfileId);
        if (sig !== 'default') {
            return `cloned[${speakerId}@${sig}]::${cleanText}`;
        }
        return role === 'pea' ? `pea[default]::${cleanText}` : `${role}::${cleanText}`;
    }

    async clearCache() {
        this._cacheEpoch += 1;
        this._ttsMemCache.clear();
        this._inflightTtsMap.clear();
        if (typeof window !== 'undefined' && typeof caches !== 'undefined' && window.isSecureContext) {
            try {
                await caches.delete(TTS_DISK_CACHE_NAME);
            } catch (_) {}
        }
    }

    _canUseDiskCache() {
        return (
            typeof window !== 'undefined' &&
            typeof caches !== 'undefined' &&
            window.isSecureContext &&
            window.__DISABLE_TTS_DISK_CACHE !== true
        );
    }

    async _readDiskCache(cacheKey) {
        if (!this._canUseDiskCache()) return '';
        try {
            const cache = await caches.open(TTS_DISK_CACHE_NAME);
            const url = `https://pea-tts-disk.local/v2/${hashTextKey(cacheKey)}`;
            const resp = await cache.match(url);
            if (!resp) return '';
            const text = await resp.text();
            return text && text.length > 40 ? text : '';
        } catch (_) {
            return '';
        }
    }

    async _writeDiskCache(cacheKey, b64) {
        if (!this._canUseDiskCache() || !b64 || b64.length <= 40) return;
        try {
            const cache = await caches.open(TTS_DISK_CACHE_NAME);
            const existingKeys = await cache.keys();
            if (existingKeys.length >= 220) {
                for (const req of existingKeys.slice(0, 30)) {
                    await cache.delete(req);
                }
            }
            const url = `https://pea-tts-disk.local/v2/${hashTextKey(cacheKey)}`;
            await cache.put(url, new Response(b64, { headers: { 'Content-Type': 'text/plain' } }));
        } catch (_) {}
    }

    _saveToMemCache(cacheKey, b64) {
        if (this._ttsMemCache.size >= 160) {
            const oldest = this._ttsMemCache.keys().next().value;
            if (oldest !== undefined) this._ttsMemCache.delete(oldest);
        }
        this._ttsMemCache.set(cacheKey, b64);
    }

    _clearTimers() {
        if (this._activeFallbackTimer) {
            clearTimeout(this._activeFallbackTimer);
            this._activeFallbackTimer = null;
        }
    }

    _revokeActiveObjectUrl() {
        if (this._activeObjectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            try { URL.revokeObjectURL(this._activeObjectUrl); } catch (_) {}
        }
        this._activeObjectUrl = null;
    }

    _stopCurrentAudioNodes() {
        this._clearTimers();
        this._revokeActiveObjectUrl();
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
        this._pendingGesturePlay = null;
        this._currentSpeakText = '';
        this._stopCurrentAudioNodes();
        this.isSpeaking = false;
        if (this._activeResolve) {
            const resolvePrev = this._activeResolve;
            this._activeResolve = null;
            resolvePrev({ ok: true, mode: this.lastPlaybackMode, cancelled: true });
        }
        this._notify();
    }

    async _fetchNeuralTtsBase64(cleanText, role = 'narrator', voiceProfileId = '') {
        if (!cleanText || !this._shouldUseCloudTts()) return '';
        const { speakerId, sig } = this._resolveSpeakerSig(role, voiceProfileId);
        const cacheKey = this._buildCacheKey(role, cleanText, speakerId);
        if (this._ttsMemCache.has(cacheKey)) {
            return this._ttsMemCache.get(cacheKey);
        }
        if (this._inflightTtsMap.has(cacheKey)) {
            return this._inflightTtsMap.get(cacheKey);
        }

        const sendProfileId = Boolean(
            speakerId && (sig !== 'default' || speakerId === 'pea' || !this._voiceProfilesLoaded)
        );
        const timeoutMs = sig !== 'default' ? 15000 : 7000;
        const reqEpoch = this._cacheEpoch;
        const reqPromise = (async () => {
            const diskHit = await this._readDiskCache(cacheKey);
            if (diskHit) {
                if (reqEpoch === this._cacheEpoch) {
                    this._saveToMemCache(cacheKey, diskHit);
                }
                return diskHit;
            }

            const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timeoutId = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
            try {
                const payload = { text: cleanText, role };
                if (sendProfileId) payload.voiceProfileId = speakerId;
                const res = await fetch('/api/tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: ctrl ? ctrl.signal : undefined
                });
                if (res.status === 404 || res.status === 405 || res.status === 501) {
                    this._cloudTtsUnavailable = true;
                    return '';
                }
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.ok && data.audioBase64) {
                        if (reqEpoch === this._cacheEpoch) {
                            this._saveToMemCache(cacheKey, data.audioBase64);
                            this._writeDiskCache(cacheKey, data.audioBase64).catch(() => {});
                        }
                        return data.audioBase64;
                    }
                }
            } catch (_) {
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
            }
            return '';
        })();

        this._inflightTtsMap.set(cacheKey, reqPromise);
        try {
            return await reqPromise;
        } finally {
            this._inflightTtsMap.delete(cacheKey);
        }
    }

    prefetch(text, role = 'narrator', voiceProfileId = '') {
        if (this.muted || !text || !this._shouldUseCloudTts()) return Promise.resolve('');
        const cleanText = cleanTextForTts(text);
        if (!cleanText) return Promise.resolve('');
        return this._fetchNeuralTtsBase64(cleanText, role, voiceProfileId).catch(() => '');
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
                if (this._audioCtx.state === 'suspended' || this._audioCtx.state === 'interrupted') {
                    await Promise.race([
                        this._audioCtx.resume().catch(() => {}),
                        new Promise(r => setTimeout(r, 350))
                    ]);
                }
                if (this._audioCtx.state === 'running') {
                    const ab = base64ToArrayBuffer(b64);
                    if (ab && ab.byteLength > 40 && token === this._speakToken) {
                        const decoded = await this._audioCtx.decodeAudioData(ab.slice(0));
                        if (token !== this._speakToken || this.muted) {
                            return { played: false, reason: 'cancelled' };
                        }
                        const durationMs = Math.max(80, Math.ceil((decoded.duration / this.playbackRate) * 1000));
                        return await new Promise((resolve) => {
                            const src = this._audioCtx.createBufferSource();
                            src.buffer = decoded;
                            src.playbackRate.value = this.playbackRate;
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

        // 2. 次选复用单例 HTMLAudioElement（ObjectURL + 完整清理防止残留或重放）
        try {
            const audio = this._sharedHtmlAudio || (typeof Audio !== 'undefined' ? new Audio() : null);
            if (audio && token === this._speakToken && !this.muted) {
                const mime = detectMimeFromBase64(b64);
                const ab = base64ToArrayBuffer(b64);
                this._revokeActiveObjectUrl();
                let srcUrl = `data:${mime};base64,${b64}`;
                if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
                    this._activeObjectUrl = URL.createObjectURL(new Blob([ab], { type: mime }));
                    srcUrl = this._activeObjectUrl;
                }
                audio.setAttribute('playsinline', 'true');
                audio.src = srcUrl;
                audio.playbackRate = this.playbackRate;
                this._activeHtmlAudio = audio;
                return await new Promise((resolve) => {
                    let settled = false;
                    const done = (ok) => {
                        if (settled) return;
                        settled = true;
                        this._clearTimers();
                        audio.onended = null;
                        audio.onerror = null;
                        if (!ok) {
                            try { audio.pause(); } catch (_) {}
                        }
                        this._revokeActiveObjectUrl();
                        if (this._activeHtmlAudio === audio) this._activeHtmlAudio = null;
                        resolve({ played: ok, mode: ok ? 'neural-mp3' : 'blocked', reason: ok ? undefined : 'autoplay_blocked' });
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
            this._revokeActiveObjectUrl();
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
                utter.rate = Math.max(0.65, Math.min(1.3, profile.rate * this.playbackRate));
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
                const approxMs = Math.max(1200, Math.min(28000, Math.ceil((cleanText.length * 240) / this.playbackRate)));
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
        const voiceProfileId = String(callbacks?.voiceProfileId || callbacks?.speakerId || '').trim();
        const dedupeKey = `${voiceProfileId || role}::${cleanText}`;
        if (this.isSpeaking && this._currentSpeakText === dedupeKey && (Date.now() - this._currentSpeakAt) < 800) {
            return { ok: true, mode: this.lastPlaybackMode || 'idle', cancelled: false, deduped: true };
        }

        this.stop();
        const token = ++this._speakToken;
        this.isSpeaking = true;
        this._currentSpeakText = dedupeKey;
        this._currentSpeakAt = Date.now();
        this.lastPlaybackMode = 'idle';
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
                this._currentSpeakText = '';
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
                const b64 = await this._fetchNeuralTtsBase64(cleanText, role, voiceProfileId);
                if (token !== this._speakToken || this.muted) {
                    finalize({ ok: true, mode: this.lastPlaybackMode, cancelled: true });
                    return;
                }

                let cloudRes = null;
                if (b64) {
                    cloudRes = await this._playBase64AndAwaitEnd(b64, token);
                    if (token !== this._speakToken || this.muted) {
                        finalize({ ok: true, mode: this.lastPlaybackMode, cancelled: true });
                        return;
                    }
                    if (cloudRes.played) {
                        finalize({ ok: true, mode: cloudRes.mode, cancelled: false });
                        return;
                    }
                }

                const localRes = await this._playLocalSpeechAndAwaitEnd(cleanText, role, token);
                if (token === this._speakToken && !this.muted && !localRes.played && cloudRes?.reason === 'autoplay_blocked') {
                    this._pendingGesturePlay = {
                        text: cleanText,
                        role,
                        callbacks: voiceProfileId ? { voiceProfileId } : {},
                        expiresAt: Date.now() + 10000
                    };
                }
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
        const voiceProfileId = String(callbacks?.voiceProfileId || callbacks?.speakerId || '').trim();
        const dedupeKey = cleanFallback ? `${voiceProfileId || role}::${cleanFallback}` : cleanB64.slice(0, 64);
        if (dedupeKey && this.isSpeaking && this._currentSpeakText === dedupeKey && (Date.now() - this._currentSpeakAt) < 800) {
            return { ok: true, mode: this.lastPlaybackMode || 'idle', cancelled: false, deduped: true };
        }
        if (!cleanB64) {
            return cleanFallback ? this.speak(cleanFallback, role, callbacks) : { ok: false, mode: 'idle', cancelled: false };
        }

        if (cleanFallback) {
            const cacheKey = this._buildCacheKey(role, cleanFallback, voiceProfileId);
            this._saveToMemCache(cacheKey, cleanB64);
            this._writeDiskCache(cacheKey, cleanB64).catch(() => {});
        }

        this.stop();
        const token = ++this._speakToken;
        this.isSpeaking = true;
        this._currentSpeakText = dedupeKey;
        this._currentSpeakAt = Date.now();
        this.lastPlaybackMode = 'idle';
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
                this._currentSpeakText = '';
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
