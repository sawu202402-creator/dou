/**
 * voiceStudio.js - 《🎙️ 小豌豆 & 好朋友声音魔法室》
 * 让小豌豆与故事书里真实出现的好朋友都能录制 10~15 秒真实声音样本并存入云端，
 * 配合 Cloudflare Worker 3 平台克隆适配器，让每位角色在所有过去与未来的故事书里说出自己的真实声线！
 */

import { escapeHtml, renderPinyinHtml } from './pinyinRenderer.js';

const MAX_RECORD_SEC = 18;
const FRIEND_EMOJIS = ['🦋', '🌈', '🌟', '🐱', '🦊', '🐼'];

const DEFAULT_PROVIDER_META = {
    provider: 'siliconflow',
    providerLabel: '硅基流动 SiliconFlow (CosyVoice2)',
    providerConfigured: false,
    configSource: 'none',
    apiKeyMasked: '',
    overrideVoiceConfigured: false
};

const PEA_GUIDED_PROMPTS = [
    {
        id: 'dream',
        label: '✨ 甜品店开张',
        text: '大家好，我是小豌豆！欢迎来到我的魔法故事漫画屋！今天阳光真温暖，快和我一起坐上棉花糖热气球，去月亮上开一家会发光的甜品店吧！',
        pinyin: 'dà jiā hǎo wǒ shì xiǎo wān dòu huān yíng lái dào wǒ de mó fǎ gù shi màn huà wū jīn tiān yáng guāng zhēn wēn nuǎn kuài hé wǒ yì qǐ zuò shàng mián hua táng rè qì qiú qù yuè liang shàng kāi yì jiā huì fā guāng de tián pǐn diàn ba'
    },
    {
        id: 'sea',
        label: '🌊 海边彩虹',
        text: '哇，快看呀！蓝蓝的大海在阳光下闪闪发亮，浪花里好像藏着一道彩虹！小海豚正朝我们游过来呢，我们一起出发去探险吧！',
        pinyin: 'wa kuài kàn ya lán lán de dà hǎi zài yáng guāng xià shǎn shǎn fā liàng làng huā lǐ hǎo xiàng cáng zhe yí dào cǎi hóng xiǎo hǎi tún zhèng cháo wǒ men yóu guò lái ne wǒ men yì qǐ chū fā qù tàn xiǎn ba'
    },
    {
        id: 'custom',
        label: '✏️ 自己写一段',
        text: '大家好，我是小豌豆！这是我自己的真实声音，以后每本故事书都要用这个好听的声音哦！',
        pinyin: ''
    }
];

function sanitizeRoleId(raw) {
    const clean = String(raw || '').trim().slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '');
    return clean || 'pea';
}

function makeFriendRoleId(name) {
    const ascii = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (ascii && ascii.length >= 2) {
        return `friend_${ascii.slice(0, 18)}`;
    }
    let h = 2166136261;
    const s = String(name || '').trim();
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return `friend_${h.toString(36)}`;
}

function float32PcmToWav16kBase64(monoFloat32, srcSampleRate = 48000) {
    const totalLen = monoFloat32?.length || 0;
    if (!totalLen) return { base64: '', durationMs: 0 };

    let maxPeak = 0;
    for (let i = 0; i < totalLen; i++) {
        const a = Math.abs(monoFloat32[i]);
        if (a > maxPeak) maxPeak = a;
    }

    const targetRate = 16000;
    const maxSamples = Math.min(totalLen, Math.floor(srcSampleRate * MAX_RECORD_SEC));
    const ratio = srcSampleRate > targetRate ? (srcSampleRate / targetRate) : 1;
    const outSamples = Math.max(1, Math.floor(maxSamples / ratio));
    const wavBytes = new ArrayBuffer(44 + outSamples * 2);
    const view = new DataView(wavBytes);
    const writeAscii = (pos, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(pos + i, str.charCodeAt(i));
    };
    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + outSamples * 2, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, outSamples * 2, true);

    const normGain = (maxPeak > 0.01 && maxPeak < 0.45) ? Math.min(3.2, 0.72 / maxPeak) : 1.0;
    let bytePos = 44;
    for (let i = 0; i < outSamples; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(maxSamples, Math.floor((i + 1) * ratio));
        let sum = 0;
        let cnt = 0;
        for (let j = start; j < end; j++) {
            sum += monoFloat32[j];
            cnt++;
        }
        const sample = cnt > 0 ? (sum / cnt) * normGain : monoFloat32[start] * normGain;
        const clamped = Math.max(-1, Math.min(1, sample));
        view.setInt16(bytePos, clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF, true);
        bytePos += 2;
    }

    const u8 = new Uint8Array(wavBytes);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < u8.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunkSize));
    }
    return {
        base64: btoa(binary),
        durationMs: Math.round((maxSamples / srcSampleRate) * 1000)
    };
}

async function decodeAudioBlobToWav16kBase64(blob) {
    const ab = await blob.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('no_audiocontext');
    const ctx = new Ctx();
    try {
        const decoded = await ctx.decodeAudioData(ab.slice(0));
        const channels = decoded.numberOfChannels || 1;
        const len = decoded.length || 0;
        const mono = new Float32Array(len);
        for (let ch = 0; ch < channels; ch++) {
            const data = decoded.getChannelData(ch);
            for (let i = 0; i < len; i++) {
                mono[i] += data[i] / channels;
            }
        }
        return float32PcmToWav16kBase64(mono, decoded.sampleRate || 16000);
    } finally {
        try { await ctx.close(); } catch (_) {}
    }
}

function mergeFloatChunks(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
    }
    return merged;
}

function formatSeconds(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
}

export class VoiceStudioController {
    constructor({ audioEngine, getBooks, loadBook, getCurrentBook, onProfileChange, onBeforeOpen } = {}) {
        this.audioEngine = audioEngine;
        this.getBooks = typeof getBooks === 'function' ? getBooks : () => [];
        this.loadBook = typeof loadBook === 'function' ? loadBook : async () => null;
        this.getCurrentBook = typeof getCurrentBook === 'function' ? getCurrentBook : () => null;
        this.onProfileChange = typeof onProfileChange === 'function' ? onProfileChange : () => {};
        this.onBeforeOpen = typeof onBeforeOpen === 'function' ? onBeforeOpen : () => {};

        this.isOpen = false;
        this.isRecording = false;
        this.isSaving = false;
        this.isTesting = false;
        this.isPlayingPreview = false;

        this.providerMeta = { ...DEFAULT_PROVIDER_META };
        this.activeRoleId = 'pea';
        this.profiles = {
            pea: this._makeDefaultProfile('pea', { name: '小豌豆', emoji: '🐰', fallbackRole: 'pea' })
        };
        this.profile = this.profiles.pea;
        this.characterCatalog = [
            { id: 'pea', name: '小豌豆', emoji: '🐰', fallbackRole: 'pea', isFeatured: true, sampleLines: [] },
            { id: 'narrator', name: '故事姐姐', emoji: '🪄', fallbackRole: 'narrator', isNarrator: true, sampleLines: [] }
        ];
        this.customCharacters = [];
        this.showAllChars = false;
        this.isAddingFriend = false;
        this.newFriendEmoji = FRIEND_EMOJIS[0];

        this.selectedPromptId = PEA_GUIDED_PROMPTS[0].id;
        this.customText = PEA_GUIDED_PROMPTS[2].text;
        this.draftSample = null; // { audioBase64, sampleMime, durationMs, sampleText }

        this._recSeconds = 0;
        this._recTimer = null;
        this._levelRaf = null;
        this._recorder = null;
        this.dom = {};
    }

    _makeDefaultProfile(roleId = 'pea', meta = {}) {
        const cleanRole = sanitizeRoleId(roleId);
        return {
            role: cleanRole,
            displayName: meta.name || (cleanRole === 'pea' ? '小豌豆' : cleanRole),
            emoji: meta.emoji || (cleanRole === 'pea' ? '🐰' : '🎙️'),
            fallbackRole: meta.fallbackRole || (cleanRole === 'pea' ? 'pea' : 'narrator'),
            hasSample: false,
            enabled: false,
            version: 0,
            durationMs: 0,
            sampleText: '',
            sampleMime: 'audio/wav',
            updatedAt: 0,
            updatedStr: '',
            cloneReady: false,
            ...this.providerMeta,
            providerVoiceSynced: false,
            overrideVoiceConfigured: cleanRole === 'pea' ? Boolean(this.providerMeta.overrideVoiceConfigured) : false,
            lastError: ''
        };
    }

    _findCharacterMeta(roleId = this.activeRoleId) {
        const cleanRole = sanitizeRoleId(roleId);
        const fromCatalog = this.characterCatalog.find((c) => c.id === cleanRole);
        if (fromCatalog) return fromCatalog;
        const fromCustom = this.customCharacters.find((c) => c.id === cleanRole);
        if (fromCustom) return fromCustom;
        const saved = this.profiles[cleanRole];
        if (saved) {
            return {
                id: cleanRole,
                name: saved.displayName || (cleanRole === 'pea' ? '小豌豆' : cleanRole),
                emoji: saved.emoji || (cleanRole === 'pea' ? '🐰' : '🎙️'),
                fallbackRole: saved.fallbackRole || 'narrator',
                sampleLines: []
            };
        }
        return cleanRole === 'pea'
            ? { id: 'pea', name: '小豌豆', emoji: '🐰', fallbackRole: 'pea', sampleLines: [] }
            : { id: cleanRole, name: cleanRole, emoji: '🎙️', fallbackRole: 'narrator', sampleLines: [] };
    }

    _syncActiveProfileProp() {
        this.profile = this.getProfile(this.activeRoleId);
    }

    init() {
        this._ensureModalDom();
        return this.refreshProfiles().catch(() => null);
    }

    getProfile(roleId = this.activeRoleId) {
        const cleanRole = sanitizeRoleId(roleId);
        const meta = this._findCharacterMeta(cleanRole);
        const base = this._makeDefaultProfile(cleanRole, meta);
        const saved = this.profiles[cleanRole];
        if (!saved) return base;
        return {
            ...base,
            ...saved,
            ...this.providerMeta,
            overrideVoiceConfigured: cleanRole === 'pea' ? Boolean(this.providerMeta.overrideVoiceConfigured) : false,
            displayName: saved.displayName || base.displayName,
            emoji: saved.emoji || base.emoji,
            fallbackRole: saved.fallbackRole || base.fallbackRole
        };
    }

    getAllProfiles() {
        return { ...this.profiles };
    }

    getSummary() {
        const list = Object.values(this.profiles || {});
        const activeProfiles = list.filter((p) => p && p.cloneReady);
        const sampledProfiles = list.filter((p) => p && (p.hasSample || p.overrideVoiceConfigured));
        return {
            activeCount: activeProfiles.length,
            sampleCount: sampledProfiles.length,
            anyReady: activeProfiles.length > 0,
            peaReady: Boolean(this.profiles?.pea?.cloneReady),
            activeNames: activeProfiles.map((p) => p.displayName || p.role).filter(Boolean)
        };
    }

    getVoiceSignature(roleId = 'pea') {
        const p = this.getProfile(roleId);
        if (p && p.cloneReady) {
            return `clone-${p.provider}-v${p.version || 1}`;
        }
        return 'default';
    }

    getVoiceSignatureMap() {
        const map = {};
        for (const [roleId, p] of Object.entries(this.profiles || {})) {
            if (p && p.cloneReady) {
                map[roleId] = `clone-${p.provider}-v${p.version || 1}`;
            }
        }
        return map;
    }

    resolveVoiceProfileId(characterId = '', characterName = '') {
        const cleanId = characterId ? sanitizeRoleId(characterId) : '';
        if (cleanId && this.profiles[cleanId]?.cloneReady) {
            return cleanId;
        }
        const cleanName = String(characterName || '').trim();
        if (cleanName) {
            const matched = Object.values(this.profiles || {}).find(
                (p) => p && p.cloneReady && String(p.displayName || '').trim() === cleanName
            );
            if (matched?.role) return matched.role;
        }
        return cleanId;
    }

    isCharacterCloned(characterId = '', characterName = '') {
        const resolved = this.resolveVoiceProfileId(characterId, characterName);
        return Boolean(resolved && this.profiles[resolved]?.cloneReady);
    }

    _shouldUseApi() {
        if (typeof window === 'undefined' || typeof fetch !== 'function') return false;
        return window.location.protocol === 'https:' || window.location.protocol === 'http:';
    }

    async refreshProfile() {
        await this.refreshProfiles();
        return this.getProfile(this.activeRoleId);
    }

    async refreshProfiles() {
        if (!this._shouldUseApi()) return this.profiles;
        try {
            const res = await fetch(`/api/voice-profiles?t=${Date.now()}`, { cache: 'no-store' });
            if (res.status === 404) {
                const singleRes = await fetch(`/api/voice-profile?role=pea&t=${Date.now()}`, { cache: 'no-store' });
                if (singleRes.ok) {
                    const singleData = await singleRes.json().catch(() => null);
                    if (singleData?.ok && singleData.profile) {
                        this._applyProfile(singleData.profile);
                    }
                }
                return this.profiles;
            }
            if (!res.ok) return this.profiles;
            const data = await res.json().catch(() => null);
            if (data?.ok) {
                this._applyProfilesPayload(data);
            }
        } catch (_) {}
        return this.profiles;
    }

    _applyProfilesPayload(data) {
        if (data.provider && typeof data.provider === 'object') {
            this.providerMeta = { ...this.providerMeta, ...data.provider };
        }
        const nextProfiles = { ...this.profiles };
        if (data.profiles && typeof data.profiles === 'object') {
            for (const [rId, prof] of Object.entries(data.profiles)) {
                const cleanRole = sanitizeRoleId(rId);
                nextProfiles[cleanRole] = { ...this._makeDefaultProfile(cleanRole), ...prof, role: cleanRole };
            }
        }
        if (!nextProfiles.pea) {
            nextProfiles.pea = this._makeDefaultProfile('pea', { name: '小豌豆', emoji: '🐰', fallbackRole: 'pea' });
        }
        this.profiles = nextProfiles;
        this._mergeCatalogProfiles();
        this._syncActiveProfileProp();
        this.audioEngine?.setVoiceSignatures?.(this.getVoiceSignatureMap(), { loaded: true });
        this._renderCharacterPicker();
        this._renderProfileState();
        this.onProfileChange(this.getSummary());
    }

    _applyProfile(nextProfile) {
        if (!nextProfile || typeof nextProfile !== 'object') return;
        const cleanRole = sanitizeRoleId(nextProfile.role || this.activeRoleId);
        if (nextProfile.provider) {
            this.providerMeta = {
                ...this.providerMeta,
                provider: nextProfile.provider,
                providerLabel: nextProfile.providerLabel || this.providerMeta.providerLabel,
                providerConfigured: Boolean(nextProfile.providerConfigured),
                configSource: nextProfile.configSource || this.providerMeta.configSource,
                apiKeyMasked: nextProfile.apiKeyMasked || this.providerMeta.apiKeyMasked,
                overrideVoiceConfigured: cleanRole === 'pea'
                    ? Boolean(nextProfile.overrideVoiceConfigured)
                    : this.providerMeta.overrideVoiceConfigured
            };
        }
        const base = this.getProfile(cleanRole);
        this.profiles[cleanRole] = { ...base, ...nextProfile, role: cleanRole };
        this._mergeCatalogProfiles();
        this._syncActiveProfileProp();
        this.audioEngine?.setVoiceSignatures?.(this.getVoiceSignatureMap(), { loaded: true });
        this._renderCharacterPicker();
        this._renderProfileState();
        this.onProfileChange(this.getSummary());
    }

    _mergeCatalogProfiles() {
        const existing = new Map(this.characterCatalog.map((c) => [c.id, c]));
        for (const p of Object.values(this.profiles || {})) {
            if (!p || !p.role || existing.has(p.role)) continue;
            if (!p.hasSample && p.role !== 'pea') continue;
            existing.set(p.role, {
                id: p.role,
                name: p.displayName || p.role,
                emoji: p.emoji || '🎙️',
                fallbackRole: p.fallbackRole || 'narrator',
                sampleLines: [],
                isCustom: true
            });
        }
        this.characterCatalog = Array.from(existing.values());
    }

    async rebuildCharacterCatalog() {
        const charMap = new Map();
        const ensureEntry = (id, patch = {}) => {
            const cleanId = sanitizeRoleId(id);
            const prev = charMap.get(cleanId) || {
                id: cleanId,
                name: patch.name || (cleanId === 'pea' ? '小豌豆' : cleanId),
                emoji: patch.emoji || (cleanId === 'pea' ? '🐰' : '🎙️'),
                fallbackRole: patch.fallbackRole || (cleanId === 'pea' ? 'pea' : 'narrator'),
                inCurrentBook: false,
                isFeatured: false,
                isNarrator: cleanId === 'narrator',
                isCustom: false,
                sampleLines: [],
                firstBookIdx: 999
            };
            const merged = {
                ...prev,
                name: patch.name || prev.name,
                emoji: patch.emoji || prev.emoji,
                fallbackRole: patch.fallbackRole || prev.fallbackRole,
                inCurrentBook: prev.inCurrentBook || Boolean(patch.inCurrentBook),
                isFeatured: prev.isFeatured || Boolean(patch.isFeatured),
                isNarrator: prev.isNarrator || Boolean(patch.isNarrator),
                isCustom: prev.isCustom || Boolean(patch.isCustom),
                firstBookIdx: Math.min(prev.firstBookIdx, patch.bookIdx ?? 999)
            };
            if (Array.isArray(patch.lines)) {
                for (const line of patch.lines) {
                    if (merged.sampleLines.length >= 2) break;
                    if (line?.text && !merged.sampleLines.some((x) => x.text === line.text)) {
                        merged.sampleLines.push(line);
                    }
                }
            }
            charMap.set(cleanId, merged);
            return merged;
        };

        ensureEntry('pea', { name: '小豌豆', emoji: '🐰', fallbackRole: 'pea', isFeatured: true, bookIdx: 0 });

        const currentBook = this.getCurrentBook();
        const manifestBooks = this.getBooks() || [];
        const loadedList = await Promise.all(
            manifestBooks.map((mb) => this.loadBook(mb.id).catch(() => null))
        );
        const booksToScan = [];
        if (currentBook && currentBook.id) booksToScan.push({ book: currentBook, isCurrent: true, idx: 0 });
        loadedList.forEach((b, idx) => {
            if (b && b.id !== currentBook?.id) {
                booksToScan.push({ book: b, isCurrent: false, idx: idx + 1 });
            }
        });

        for (const item of booksToScan) {
            const book = item.book;
            const chars = book.characters || {};
            const linesByChar = new Map();
            for (const page of (book.pages || [])) {
                for (const panel of (page.panels || [])) {
                    for (const b of (panel.bubbles || [])) {
                        if (!b?.characterId || !b?.text || b.text.length < 6) continue;
                        const cid = sanitizeRoleId(b.characterId);
                        if (!linesByChar.has(cid)) linesByChar.set(cid, []);
                        if (linesByChar.get(cid).length < 2) {
                            linesByChar.get(cid).push({ text: b.text, pinyin: b.pinyin || '' });
                        }
                    }
                }
            }

            let friendRank = 0;
            for (const [rawCid, cObj] of Object.entries(chars)) {
                const cid = sanitizeRoleId(rawCid);
                const isNarr = cid === 'narrator';
                const isFirstFriend = cid !== 'pea' && !isNarr && friendRank === 0;
                if (cid !== 'pea' && !isNarr) friendRank += 1;
                ensureEntry(cid, {
                    name: cObj?.name || cid,
                    emoji: cObj?.emoji || '🎙️',
                    fallbackRole: cObj?.voiceRole || (isNarr ? 'narrator' : 'fairy'),
                    inCurrentBook: item.isCurrent && !isNarr,
                    isFeatured: isFirstFriend,
                    isNarrator: isNarr,
                    bookIdx: item.idx,
                    lines: linesByChar.get(cid) || []
                });
            }
        }

        for (const prof of Object.values(this.profiles || {})) {
            if (!prof || !prof.role) continue;
            if (!charMap.has(prof.role) && (prof.hasSample || prof.role === this.activeRoleId)) {
                ensureEntry(prof.role, {
                    name: prof.displayName || prof.role,
                    emoji: prof.emoji || '🎙️',
                    fallbackRole: prof.fallbackRole || 'narrator',
                    isCustom: true,
                    bookIdx: 500
                });
            }
        }

        for (const cust of this.customCharacters) {
            if (!cust || !cust.id) continue;
            ensureEntry(cust.id, {
                name: cust.name,
                emoji: cust.emoji || '🦋',
                fallbackRole: cust.fallbackRole || 'fairy',
                isCustom: true,
                bookIdx: 400
            });
        }

        ensureEntry('narrator', { name: '故事姐姐', emoji: '🪄', fallbackRole: 'narrator', isNarrator: true, bookIdx: 9999 });

        const rankOf = (c) => {
            if (c.id === 'pea') return 0;
            if (c.id === 'narrator') return 9;
            if (c.inCurrentBook) return 1;
            const p = this.profiles[c.id];
            if (p && (p.hasSample || p.cloneReady)) return 2;
            if (c.isFeatured) return 3;
            if (c.isCustom) return 4;
            return 5;
        };

        this.characterCatalog = Array.from(charMap.values()).sort((a, b) => {
            const diff = rankOf(a) - rankOf(b);
            if (diff !== 0) return diff;
            return a.firstBookIdx - b.firstBookIdx;
        });

        this._syncActiveProfileProp();
        this._renderCharacterPicker();
        if (this.isOpen && this.selectedPromptId !== 'custom') {
            this._renderPromptArea();
        }
        this._renderProfileState();
    }

    _ensureCustomCharacter(target) {
        if (!target) return 'pea';
        if (typeof target === 'string') {
            return sanitizeRoleId(target);
        }
        const rawId = sanitizeRoleId(target.id || target.role || makeFriendRoleId(target.name));
        if (!this.characterCatalog.some((c) => c.id === rawId) && !this.customCharacters.some((c) => c.id === rawId)) {
            this.customCharacters.push({
                id: rawId,
                name: String(target.name || rawId).trim().slice(0, 12),
                emoji: String(target.emoji || '🦋').trim().slice(0, 8),
                fallbackRole: String(target.fallbackRole || 'fairy').trim() || 'fairy',
                isCustom: true
            });
        }
        return rawId;
    }

    open(target = null) {
        this._ensureModalDom();
        this.onBeforeOpen();
        const nextRole = target ? this._ensureCustomCharacter(target) : 'pea';
        if (nextRole !== this.activeRoleId) {
            this.activeRoleId = nextRole;
            this.draftSample = null;
            if (this.dom.draftActions) this.dom.draftActions.hidden = true;
            const prompts = this._getGuidedPromptsForChar(this._findCharacterMeta(this.activeRoleId));
            this.selectedPromptId = prompts[0].id;
            this.customText = prompts[prompts.length - 1].text;
        }
        this.isAddingFriend = false;
        if (this.dom.addFriendBar) this.dom.addFriendBar.hidden = true;
        this.isOpen = true;
        this.dom.overlay.hidden = false;
        this._syncActiveProfileProp();
        this._renderCharacterPicker();
        this._renderPromptArea();
        this._renderProfileState();
        this.rebuildCharacterCatalog().catch(() => {});
        this.refreshProfiles().catch(() => {});
    }

    close() {
        if (!this.dom.overlay) return;
        if (this.isRecording) {
            this.stopRecording({ discard: true }).catch(() => {});
        }
        this.audioEngine?.stop?.();
        this.isOpen = false;
        this.dom.overlay.hidden = true;
    }

    selectCharacter(roleId) {
        const cleanRole = sanitizeRoleId(roleId);
        if (this.isRecording) {
            this.stopRecording({ discard: true }).catch(() => {});
        }
        this.activeRoleId = cleanRole;
        this.draftSample = null;
        if (this.dom.draftActions) this.dom.draftActions.hidden = true;
        if (this.dom.recTimer) this.dom.recTimer.textContent = `00:00 / ${MAX_RECORD_SEC}s`;
        if (this.dom.levelFill) this.dom.levelFill.style.width = '0%';

        const charMeta = this._findCharacterMeta(cleanRole);
        const prompts = this._getGuidedPromptsForChar(charMeta);
        this.selectedPromptId = prompts[0].id;
        this.customText = prompts[prompts.length - 1].text;
        this._syncActiveProfileProp();

        this._renderCharacterPicker();
        this._renderPromptArea();
        this._renderProfileState();
        if (this.dom.statusHint) {
            this.dom.statusHint.textContent = cleanRole === 'pea'
                ? '💡 录好后存在云端，以后每一次出新书都不用重新录，直接用你的专属声音！'
                : `🎙️ 现在正在给【${charMeta.emoji} ${charMeta.name}】录制专属声音，念完一段就能让故事里的 ${charMeta.name} 开口说话啦！`;
        }
    }

    addCustomFriend(name, emoji = FRIEND_EMOJIS[0]) {
        const trimmed = String(name || '').trim().slice(0, 12);
        if (!trimmed) {
            if (this.dom.statusHint) {
                this.dom.statusHint.textContent = '✏️ 先输入好朋友的名字（比如：乐乐、朵朵），再点添加哦～';
            }
            return '';
        }
        const duplicate = this.characterCatalog.find((c) => String(c.name || '').trim() === trimmed);
        if (duplicate) {
            this.isAddingFriend = false;
            if (this.dom.addFriendBar) this.dom.addFriendBar.hidden = true;
            this.selectCharacter(duplicate.id);
            if (this.dom.statusHint) {
                this.dom.statusHint.textContent = `✨ 故事书里已经有【${duplicate.emoji} ${duplicate.name}】啦，已直接帮你选中，现在就能录声音！`;
            }
            return duplicate.id;
        }
        const friendId = makeFriendRoleId(trimmed);
        const safeEmoji = FRIEND_EMOJIS.includes(emoji) ? emoji : FRIEND_EMOJIS[0];
        this.customCharacters.push({
            id: friendId,
            name: trimmed,
            emoji: safeEmoji,
            fallbackRole: 'fairy',
            isCustom: true
        });
        this.isAddingFriend = false;
        if (this.dom.addFriendBar) this.dom.addFriendBar.hidden = true;
        if (this.dom.friendNameInput) this.dom.friendNameInput.value = '';
        this.rebuildCharacterCatalog().catch(() => {});
        this.selectCharacter(friendId);
        return friendId;
    }

    _ensureModalDom() {
        if (this.dom.overlay) return;

        const overlay = document.createElement('div');
        overlay.id = 'voiceStudioOverlay';
        overlay.className = 'vs-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="vs-modal" role="dialog" aria-modal="true" aria-labelledby="vsModalTitle">
                <header class="vs-header">
                    <div class="vs-header-left">
                        <span class="vs-header-avatar" aria-hidden="true">🎙️</span>
                        <div class="vs-header-titles">
                            <h2 id="vsModalTitle">小豌豆 &amp; 好朋友声音魔法室</h2>
                            <p class="vs-header-sub">小豌豆和故事里的小伙伴都能各自录 10～15 秒真声音，新书旧书自动开口说！</p>
                        </div>
                    </div>
                    <button type="button" id="vsCloseBtn" class="vs-close-btn" aria-label="关闭声音魔法室">✕</button>
                </header>

                <div class="vs-body">
                    <section class="vs-char-picker" id="vsCharPicker" aria-label="选择录制声音的角色">
                        <div class="vs-char-head">
                            <span class="vs-char-head-title">👥 选一位要录制声音的角色</span>
                            <span class="vs-char-count" id="vsCharCount">小豌豆 &amp; 好朋友都能录</span>
                        </div>
                        <div class="vs-char-grid" id="vsCharGrid"></div>
                        <div class="vs-add-friend-bar" id="vsAddFriendBar" hidden>
                            <div class="vs-emoji-picks" id="vsEmojiPicks">
                                <span class="vs-emoji-pick-label">挑个头像：</span>
                                ${FRIEND_EMOJIS.map((em, idx) => `<button type="button" class="vs-emoji-pick ${idx === 0 ? 'is-active' : ''}" data-emoji="${em}">${em}</button>`).join('')}
                            </div>
                            <div class="vs-friend-input-row">
                                <input type="text" id="vsFriendNameInput" class="vs-friend-input" maxlength="12" placeholder="输入好朋友名字，如：乐乐">
                                <button type="button" id="vsFriendConfirmBtn" class="vs-btn vs-btn-primary">确认添加</button>
                                <button type="button" id="vsFriendCancelBtn" class="vs-btn vs-btn-ghost">取消</button>
                            </div>
                        </div>
                    </section>

                    <section class="vs-status-card" id="vsStatusCard">
                        <div class="vs-status-top">
                            <span class="vs-status-badge" id="vsStatusBadge">🎙️ 待录制</span>
                            <span class="vs-provider-pill" id="vsProviderPill">硅基流动 CosyVoice2</span>
                        </div>
                        <div class="vs-status-title" id="vsStatusTitle">还没录制小豌豆的声音样本哦</div>
                        <div class="vs-status-sub" id="vsStatusSub">选一张下面的小卡片，点击「开始念 10~15 秒」大声读出来就可以啦～</div>
                    </section>

                    <section class="vs-studio-card">
                        <div class="vs-section-head">
                            <span class="vs-step-pill">第 1 步</span>
                            <h3>选一段好听的话照着念（或自己写）</h3>
                        </div>
                        <div class="vs-prompt-tabs" id="vsPromptTabs" role="tablist" aria-label="选择朗读台词"></div>
                        <div class="vs-prompt-card" id="vsPromptCard"></div>

                        <div class="vs-section-head vs-rec-head">
                            <span class="vs-step-pill">第 2 步</span>
                            <h3>按大按钮开始录音（建议 10～15 秒，最长 18 秒）</h3>
                        </div>
                        <div class="vs-meter-row">
                            <div class="vs-meter-track" aria-hidden="true">
                                <div class="vs-meter-fill" id="vsLevelFill"></div>
                            </div>
                            <span class="vs-timer" id="vsRecTimer">00:00 / 18s</span>
                        </div>
                        <div class="vs-rec-actions">
                            <button type="button" id="vsRecBtn" class="vs-rec-btn">
                                <span id="vsRecIcon">🎙️</span>
                                <span id="vsRecLabel">开始念 10~15 秒</span>
                            </button>
                        </div>
                        <div class="vs-draft-actions" id="vsDraftActions" hidden>
                            <button type="button" id="vsPreviewDraftBtn" class="vs-btn vs-btn-soft">▶️ 听听我刚录的</button>
                            <button type="button" id="vsSaveBtn" class="vs-btn vs-btn-primary">✨ 保存TA的专属声线</button>
                            <button type="button" id="vsRetryBtn" class="vs-btn vs-btn-ghost">🔄 重录</button>
                        </div>
                    </section>

                    <section class="vs-saved-card" id="vsSavedCard" hidden>
                        <div class="vs-saved-top">
                            <div class="vs-saved-info">
                                <h3 id="vsSavedTitle">🌟 小豌豆专属声线档案</h3>
                                <p id="vsSavedMeta">已保存真实原声样本</p>
                            </div>
                            <label class="vs-switch-wrap">
                                <span class="vs-switch-label" id="vsEnableLabel">已开启</span>
                                <button type="button" id="vsEnableSwitch" class="vs-switch" role="switch" aria-checked="true" aria-label="是否在全书开启该角色专属声线">
                                    <span class="vs-switch-thumb"></span>
                                </button>
                            </label>
                        </div>
                        <div class="vs-saved-btns">
                            <button type="button" id="vsPlaySavedBtn" class="vs-btn vs-btn-soft">▶️ 听已存原声</button>
                            <button type="button" id="vsTestCloneBtn" class="vs-btn vs-btn-mint">🧪 试听 AI 克隆效果</button>
                            <button type="button" id="vsDeleteBtn" class="vs-btn vs-btn-danger">🗑️ 删除样本</button>
                        </div>
                    </section>

                    <div id="vsStatusHint" class="vs-status-hint" role="status" aria-live="polite">
                        💡 录好后存在云端，以后每一次出新书都不用重新录，直接用专属声音！
                    </div>

                    <details class="vs-parent-details">
                        <summary>👨‍👩‍👧 家长配置说明（Cloudflare 后台填 Key 生效 AI 克隆）</summary>
                        <div class="vs-parent-body" id="vsParentGuide"></div>
                    </details>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        this.dom = {
            overlay,
            closeBtn: overlay.querySelector('#vsCloseBtn'),
            charPicker: overlay.querySelector('#vsCharPicker'),
            charCount: overlay.querySelector('#vsCharCount'),
            charGrid: overlay.querySelector('#vsCharGrid'),
            addFriendBar: overlay.querySelector('#vsAddFriendBar'),
            emojiPicks: overlay.querySelector('#vsEmojiPicks'),
            friendNameInput: overlay.querySelector('#vsFriendNameInput'),
            friendConfirmBtn: overlay.querySelector('#vsFriendConfirmBtn'),
            friendCancelBtn: overlay.querySelector('#vsFriendCancelBtn'),
            statusCard: overlay.querySelector('#vsStatusCard'),
            statusBadge: overlay.querySelector('#vsStatusBadge'),
            providerPill: overlay.querySelector('#vsProviderPill'),
            statusTitle: overlay.querySelector('#vsStatusTitle'),
            statusSub: overlay.querySelector('#vsStatusSub'),
            promptTabs: overlay.querySelector('#vsPromptTabs'),
            promptCard: overlay.querySelector('#vsPromptCard'),
            levelFill: overlay.querySelector('#vsLevelFill'),
            recTimer: overlay.querySelector('#vsRecTimer'),
            recBtn: overlay.querySelector('#vsRecBtn'),
            recIcon: overlay.querySelector('#vsRecIcon'),
            recLabel: overlay.querySelector('#vsRecLabel'),
            draftActions: overlay.querySelector('#vsDraftActions'),
            previewDraftBtn: overlay.querySelector('#vsPreviewDraftBtn'),
            saveBtn: overlay.querySelector('#vsSaveBtn'),
            retryBtn: overlay.querySelector('#vsRetryBtn'),
            savedCard: overlay.querySelector('#vsSavedCard'),
            savedTitle: overlay.querySelector('#vsSavedTitle'),
            savedMeta: overlay.querySelector('#vsSavedMeta'),
            enableLabel: overlay.querySelector('#vsEnableLabel'),
            enableSwitch: overlay.querySelector('#vsEnableSwitch'),
            playSavedBtn: overlay.querySelector('#vsPlaySavedBtn'),
            testCloneBtn: overlay.querySelector('#vsTestCloneBtn'),
            deleteBtn: overlay.querySelector('#vsDeleteBtn'),
            statusHint: overlay.querySelector('#vsStatusHint'),
            parentGuide: overlay.querySelector('#vsParentGuide')
        };

        this.dom.closeBtn.addEventListener('click', () => this.close());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.close();
        });

        this.dom.emojiPicks?.querySelectorAll('.vs-emoji-pick').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.newFriendEmoji = btn.getAttribute('data-emoji') || FRIEND_EMOJIS[0];
                this.dom.emojiPicks.querySelectorAll('.vs-emoji-pick').forEach((el) => {
                    el.classList.toggle('is-active', el === btn);
                });
            });
        });

        this.dom.friendConfirmBtn?.addEventListener('click', () => {
            this.addCustomFriend(this.dom.friendNameInput?.value || '', this.newFriendEmoji);
        });
        this.dom.friendNameInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.addCustomFriend(this.dom.friendNameInput?.value || '', this.newFriendEmoji);
            }
        });
        this.dom.friendCancelBtn?.addEventListener('click', () => {
            this.isAddingFriend = false;
            if (this.dom.addFriendBar) this.dom.addFriendBar.hidden = true;
        });

        this.dom.recBtn.addEventListener('click', () => {
            this.audioEngine?.unlockInGesture?.();
            if (this.isRecording) {
                this.stopRecording();
            } else {
                this.startRecording();
            }
        });

        this.dom.previewDraftBtn.addEventListener('click', () => {
            this.audioEngine?.unlockInGesture?.();
            if (this.draftSample?.audioBase64) {
                this.audioEngine?.playBase64Audio?.(this.draftSample.audioBase64, '');
            }
        });

        this.dom.saveBtn.addEventListener('click', () => {
            this.audioEngine?.unlockInGesture?.();
            this.saveDraftSample();
        });

        this.dom.retryBtn.addEventListener('click', () => {
            this.draftSample = null;
            this.dom.draftActions.hidden = true;
            this.dom.recTimer.textContent = `00:00 / ${MAX_RECORD_SEC}s`;
            this.dom.levelFill.style.width = '0%';
            this.dom.statusHint.textContent = '🔄 好哒！深呼吸一口气，点上面大按钮再自然朗读一遍吧～';
        });

        this.dom.enableSwitch.addEventListener('click', () => {
            this.audioEngine?.unlockInGesture?.();
            const cur = this.getProfile(this.activeRoleId);
            this.toggleEnabled(!cur.enabled);
        });

        this.dom.playSavedBtn.addEventListener('click', () => {
            this.audioEngine?.unlockInGesture?.();
            this.playSavedSample();
        });

        this.dom.testCloneBtn.addEventListener('click', () => {
            this.audioEngine?.unlockInGesture?.();
            this.testClonedVoice();
        });

        this.dom.deleteBtn.addEventListener('click', () => {
            this.deleteSavedSample();
        });

        this._renderCharacterPicker();
        this._renderPromptArea();
        this._renderProfileState();
    }

    _renderCharacterPicker() {
        if (!this.dom.charGrid) return;
        const summary = this.getSummary();
        if (this.dom.charCount) {
            this.dom.charCount.textContent = summary.activeCount > 0
                ? `✨ ${summary.activeCount} 位专属声音已开启`
                : '小豌豆 & 好朋友都能录';
        }

        const catalog = this.characterCatalog || [];
        let visible = catalog;
        if (!this.showAllChars && catalog.length > 7) {
            visible = catalog.slice(0, 7);
            if (!visible.some((c) => c.id === this.activeRoleId)) {
                const activeMeta = catalog.find((c) => c.id === this.activeRoleId);
                if (activeMeta) visible = [...visible.slice(0, 6), activeMeta];
            }
        }

        const chipsHtml = visible.map((c) => {
            const prof = this.profiles[c.id];
            const activeCls = c.id === this.activeRoleId ? ' is-active' : '';
            const dotCls = prof?.cloneReady
                ? 'is-ready'
                : ((prof?.hasSample || prof?.overrideVoiceConfigured) ? 'is-saved' : '');
            return `
                <button type="button" class="vs-char-chip${activeCls}" data-char-id="${escapeHtml(c.id)}">
                    <span>${escapeHtml(c.emoji || '🎙️')}</span>
                    <span>${escapeHtml(c.name)}</span>
                    ${dotCls ? `<span class="vs-char-dot ${dotCls}" aria-hidden="true"></span>` : ''}
                </button>
            `;
        }).join('');

        const moreHtml = catalog.length > 7
            ? `<button type="button" id="vsToggleMoreCharsBtn" class="vs-char-chip vs-char-chip-more">${this.showAllChars ? '收起角色 ▴' : `更多角色 (${catalog.length - visible.length}) ▾`}</button>`
            : '';

        const addHtml = `<button type="button" id="vsAddFriendBtn" class="vs-char-chip vs-char-chip-add">${this.isAddingFriend ? '✕ 收起' : '➕ 新朋友'}</button>`;

        this.dom.charGrid.innerHTML = chipsHtml + moreHtml + addHtml;

        this.dom.charGrid.querySelectorAll('.vs-char-chip[data-char-id]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.selectCharacter(btn.getAttribute('data-char-id'));
            });
        });

        this.dom.charGrid.querySelector('#vsToggleMoreCharsBtn')?.addEventListener('click', () => {
            this.showAllChars = !this.showAllChars;
            this._renderCharacterPicker();
        });

        this.dom.charGrid.querySelector('#vsAddFriendBtn')?.addEventListener('click', () => {
            this.isAddingFriend = !this.isAddingFriend;
            if (this.dom.addFriendBar) {
                this.dom.addFriendBar.hidden = !this.isAddingFriend;
                if (this.isAddingFriend) {
                    setTimeout(() => this.dom.friendNameInput?.focus(), 30);
                }
            }
            this._renderCharacterPicker();
        });
    }

    _getGuidedPromptsForChar(charMeta) {
        if (!charMeta || charMeta.id === 'pea') {
            return PEA_GUIDED_PROMPTS;
        }
        const name = charMeta.name || '好朋友';
        const prompts = [
            {
                id: 'intro',
                label: '✨ 角色自我介绍',
                text: `大家好，我是${name}！我是小豌豆的好朋友，欢迎来到小豌豆魔法故事漫画屋，今天我们一起去大冒险吧！`,
                pinyin: ''
            }
        ];
        if (Array.isArray(charMeta.sampleLines) && charMeta.sampleLines.length > 0) {
            const combinedText = charMeta.sampleLines.map((l) => l.text).join(' ');
            const combinedPinyin = charMeta.sampleLines.every((l) => l.pinyin)
                ? charMeta.sampleLines.map((l) => l.pinyin).join(' ')
                : '';
            prompts.push({
                id: 'bookline',
                label: '📖 念书里的台词',
                text: combinedText.slice(0, 120),
                pinyin: combinedPinyin
            });
        }
        prompts.push({
            id: 'sea',
            label: PEA_GUIDED_PROMPTS[1].label,
            text: PEA_GUIDED_PROMPTS[1].text,
            pinyin: PEA_GUIDED_PROMPTS[1].pinyin
        });
        prompts.push({
            id: 'custom',
            label: '✏️ 自己写一段',
            text: `大家好，我是${name}！这是我自己的真实声音，以后我在故事里就用这个好听的声音说话啦！`,
            pinyin: ''
        });
        return prompts;
    }

    _getActivePromptText() {
        const prompts = this._getGuidedPromptsForChar(this._findCharacterMeta(this.activeRoleId));
        if (this.selectedPromptId === 'custom') {
            return (this.customText || '').trim() || prompts[0].text;
        }
        return (prompts.find((p) => p.id === this.selectedPromptId) || prompts[0]).text;
    }

    _renderPromptArea() {
        if (!this.dom.promptTabs || !this.dom.promptCard) return;
        const prompts = this._getGuidedPromptsForChar(this._findCharacterMeta(this.activeRoleId));
        if (!prompts.some((p) => p.id === this.selectedPromptId)) {
            this.selectedPromptId = prompts[0].id;
        }

        this.dom.promptTabs.innerHTML = prompts.map((p) => {
            const active = p.id === this.selectedPromptId ? 'is-active' : '';
            return `<button type="button" class="vs-prompt-tab ${active}" data-prompt-id="${escapeHtml(p.id)}">${escapeHtml(p.label)}</button>`;
        }).join('');

        this.dom.promptTabs.querySelectorAll('.vs-prompt-tab').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.selectedPromptId = btn.getAttribute('data-prompt-id') || prompts[0].id;
                this._renderPromptArea();
            });
        });

        if (this.selectedPromptId === 'custom') {
            this.dom.promptCard.innerHTML = `
                <label class="vs-custom-label" for="vsCustomTextInput">自己写一段想念的话（25~60 个字效果最好）：</label>
                <textarea id="vsCustomTextInput" class="vs-custom-textarea" rows="3" maxlength="160">${escapeHtml(this.customText)}</textarea>
            `;
            const ta = this.dom.promptCard.querySelector('#vsCustomTextInput');
            ta?.addEventListener('input', () => {
                this.customText = ta.value;
            });
        } else {
            const item = prompts.find((p) => p.id === this.selectedPromptId) || prompts[0];
            this.dom.promptCard.innerHTML = `
                <div class="vs-prompt-text">${renderPinyinHtml(item.text, item.pinyin)}</div>
            `;
        }
    }

    _renderProfileState() {
        if (!this.dom.statusCard) return;
        const p = this.getProfile(this.activeRoleId);
        const charMeta = this._findCharacterMeta(this.activeRoleId);
        const name = charMeta.name || p.displayName || '小豌豆';
        const emoji = charMeta.emoji || p.emoji || '🎙️';
        const badge = this.dom.statusBadge;
        const pill = this.dom.providerPill;
        const title = this.dom.statusTitle;
        const sub = this.dom.statusSub;

        pill.textContent = p.providerConfigured
            ? `${p.providerLabel || p.provider} · 密钥已配好`
            : `${p.providerLabel || p.provider} · 待填 Key`;

        if (p.cloneReady) {
            this.dom.statusCard.dataset.state = 'ready';
            badge.textContent = `✨ ${emoji} ${name}声线生效中`;
            title.textContent = `${name}的专属 AI 声音已经全书开启！`;
            sub.textContent = `所有过去与未来的故事书里，遇到「${name}」开口都会用这段真实好听的声音读出来哦！`;
        } else if (p.hasSample && !p.providerConfigured) {
            this.dom.statusCard.dataset.state = 'pending_key';
            badge.textContent = `☁️ ${emoji} ${name}原声已存 · 待填 Key`;
            title.textContent = `太棒啦！${name}的真实原声已存好（第 ${p.version || 1} 版）`;
            sub.textContent = '等爸爸妈妈在 Cloudflare 后台填好克隆平台 API Key，就能自动把书里的对话换成这段声线！';
        } else if ((p.hasSample || p.overrideVoiceConfigured) && !p.enabled) {
            this.dom.statusCard.dataset.state = 'paused';
            badge.textContent = `⏸️ ${emoji} 已暂停${name}专属声音`;
            title.textContent = `已暂时切换回默认 AI 声线（${name}）`;
            sub.textContent = `想听${name}的真实配音时，把下面开关重新打开就可以秒切回来！`;
        } else {
            this.dom.statusCard.dataset.state = 'empty';
            badge.textContent = `🎙️ 待录制 · ${emoji} ${name}`;
            title.textContent = `还没录制【${emoji} ${name}】的声音样本哦`;
            sub.textContent = p.role === 'pea'
                ? '挑一段话自然大声念 10~15 秒，以后每一本新书里的小豌豆都是你的声音！'
                : `请${name}或小伙伴对着话筒自然念 10~15 秒，以后所有故事书里的「${name}」都会是TA的声音！`;
        }

        if (this.dom.saveBtn) {
            this.dom.saveBtn.textContent = `✨ 保存${name}的专属声线`;
        }

        const showSaved = Boolean(p.hasSample || p.overrideVoiceConfigured);
        this.dom.savedCard.hidden = !showSaved;
        if (showSaved) {
            if (this.dom.savedTitle) {
                this.dom.savedTitle.textContent = `🌟 ${emoji} ${name}专属声线档案`;
            }
            const sec = p.durationMs ? `${(p.durationMs / 1000).toFixed(1)} 秒` : '预设音色';
            const syncLabel = p.providerConfigured
                ? (p.providerVoiceSynced ? ' · 云端音色已同步' : ' · 将在首次朗读时自动注册音色')
                : ' · 待配置克隆密钥';
            this.dom.savedMeta.textContent = `第 ${p.version || 1} 版 · 时长 ${sec}${p.updatedStr ? ` · ${p.updatedStr}` : ''}${syncLabel}`;
            this.dom.enableSwitch.setAttribute('aria-checked', String(Boolean(p.enabled)));
            this.dom.enableLabel.textContent = p.enabled ? '已开启' : '已暂停';
            this.dom.playSavedBtn.hidden = !p.hasSample;
        }

        if (p.lastError && this.isOpen) {
            this.dom.statusHint.textContent = `ℹ️ 最近同步提示：${p.lastError.slice(0, 90)}`;
        }

        if (this.dom.parentGuide) {
            const keyInfo = p.providerConfigured
                ? `✅ 已检测到 <strong>${escapeHtml(p.provider)}</strong> 密钥${p.apiKeyMasked ? `（<code>${escapeHtml(p.apiKeyMasked)}</code> · ${p.configSource === 'cloud_do' ? '云端 Durable Object 加密配置' : 'Cloudflare Secret'}）` : ''}`
                : '⏳ 暂未配置 VOICE_CLONE_API_KEY（样本仍可提前录好存进云端 DO）';
            this.dom.parentGuide.innerHTML = `
                <p>可在 Cloudflare Dashboard → Workers &amp; Pages → <strong>pea-story-house</strong> → Settings → Variables &amp; Secrets 添加以下变量，或通过本地 <code>mailbox_cli.mjs voice-config</code> 安全写入云端配置：</p>
                <div class="vs-env-table">
                    <div><code>VOICE_CLONE_PROVIDER</code> = <code>siliconflow</code> | <code>minimax</code> | <code>fishaudio</code>（默认 <code>siliconflow</code>）</div>
                    <div><code>VOICE_CLONE_API_KEY</code> = 对应平台密钥（仅保存在云端，从不下发前端）</div>
                    <div>可选：<code>VOICE_CLONE_MODEL</code>、<code>VOICE_CLONE_BASE_URL</code>、<code>VOICE_CLONE_VOICE_ID</code></div>
                </div>
                <p class="vs-parent-note">当前服务器状态：${keyInfo}</p>
            `;
        }
    }

    async startRecording() {
        if (this.isRecording || this.isSaving) return;
        this.audioEngine?.stop?.();

        if (typeof window !== 'undefined' && window.__MOCK_VOICE_STUDIO_WAV__) {
            this.isRecording = true;
            this._recSeconds = 0;
            this.dom.recBtn.classList.add('is-recording');
            this.dom.recIcon.textContent = '⏹️';
            this.dom.recLabel.textContent = '念好点这里 (0s)';
            this.dom.levelFill.style.width = '48%';
            this.dom.recTimer.textContent = `00:00 / ${MAX_RECORD_SEC}s`;
            this._recTimer = setInterval(() => {
                if (!this.isRecording) return;
                this._recSeconds += 1;
                this.dom.recTimer.textContent = `${formatSeconds(this._recSeconds)} / ${MAX_RECORD_SEC}s`;
                this.dom.recLabel.textContent = `念好点这里 (${this._recSeconds}s)`;
            }, 1000);
            this._recorder = { mode: 'mock', startedAt: Date.now() };
            const charMeta = this._findCharacterMeta(this.activeRoleId);
            this.dom.statusHint.textContent = `🎙️ 正在录制【${charMeta.name}】的声音样本…（模拟录音中）`;
            return;
        }

        try {
            this.dom.statusHint.textContent = '🎙️ 正在打开小话筒，请在安静的房间里自然朗读哦…';
            let stream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
                });
            } catch (_) {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }

            const Ctx = window.AudioContext || window.webkitAudioContext;
            let analyser = null;
            let meterCtx = null;

            if (typeof MediaRecorder !== 'undefined') {
                const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
                const chosen = (typeof MediaRecorder.isTypeSupported === 'function')
                    ? (candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '')
                    : '';
                const mediaRecorder = chosen ? new MediaRecorder(stream, { mimeType: chosen }) : new MediaRecorder(stream);
                const blobParts = [];
                mediaRecorder.ondataavailable = (ev) => {
                    if (ev.data && ev.data.size > 0) blobParts.push(ev.data);
                };
                mediaRecorder.start(250);

                if (Ctx) {
                    try {
                        meterCtx = new Ctx();
                        const src = meterCtx.createMediaStreamSource(stream);
                        analyser = meterCtx.createAnalyser();
                        analyser.fftSize = 256;
                        src.connect(analyser);
                    } catch (_) {}
                }
                this._recorder = { mode: 'mediarecorder', stream, mediaRecorder, blobParts, meterCtx, analyser, startedAt: Date.now() };
            } else {
                const recCtx = new Ctx();
                if (recCtx.state === 'suspended') await recCtx.resume();
                const source = recCtx.createMediaStreamSource(stream);
                const processor = recCtx.createScriptProcessor(4096, 1, 1);
                const zeroGain = recCtx.createGain();
                zeroGain.gain.value = 0;
                const chunks = [];
                analyser = recCtx.createAnalyser();
                analyser.fftSize = 256;
                processor.onaudioprocess = (ev) => {
                    if (this.isRecording) chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
                };
                source.connect(analyser);
                source.connect(processor);
                processor.connect(zeroGain);
                zeroGain.connect(recCtx.destination);
                this._recorder = {
                    mode: 'webaudio',
                    stream,
                    recCtx,
                    source,
                    processor,
                    zeroGain,
                    chunks,
                    analyser,
                    sampleRate: recCtx.sampleRate || 48000,
                    startedAt: Date.now()
                };
            }

            this.isRecording = true;
            this._recSeconds = 0;
            this.draftSample = null;
            this.dom.draftActions.hidden = true;
            this.dom.recBtn.classList.add('is-recording');
            this.dom.recIcon.textContent = '⏹️';
            this.dom.recLabel.textContent = '念好点这里 (0s)';
            this.dom.recTimer.textContent = `00:00 / ${MAX_RECORD_SEC}s`;
            this.dom.statusHint.textContent = '🎙️ 正在认真听小豌豆念故事！念完点一下停止按钮就可以先试听啦～';

            if (analyser) {
                const bins = new Uint8Array(analyser.frequencyBinCount);
                const tickMeter = () => {
                    if (!this.isRecording || !analyser) return;
                    analyser.getByteTimeDomainData(bins);
                    let peak = 0;
                    for (let i = 0; i < bins.length; i++) {
                        const v = Math.abs(bins[i] - 128) / 128;
                        if (v > peak) peak = v;
                    }
                    const pct = Math.min(100, Math.max(8, Math.round(peak * 220)));
                    this.dom.levelFill.style.width = `${pct}%`;
                    this._levelRaf = requestAnimationFrame(tickMeter);
                };
                this._levelRaf = requestAnimationFrame(tickMeter);
            }

            this._recTimer = setInterval(() => {
                if (!this.isRecording) return;
                this._recSeconds += 1;
                this.dom.recTimer.textContent = `${formatSeconds(this._recSeconds)} / ${MAX_RECORD_SEC}s`;
                this.dom.recLabel.textContent = `念好点这里 (${this._recSeconds}s)`;
                if (this._recSeconds >= MAX_RECORD_SEC) {
                    this.stopRecording();
                }
            }, 1000);
        } catch (err) {
            this.isRecording = false;
            const errName = String(err?.name || '');
            this.dom.statusHint.textContent = (errName === 'NotAllowedError' || errName === 'PermissionDeniedError')
                ? '⚠️ 麦克风没有被允许哦：请在浏览器设置里允许麦克风访问再试一次～'
                : '⚠️ 这台设备暂时打不开麦克风，换个浏览器或在 iPad Safari 上试一下吧！';
        }
    }

    async stopRecording({ discard = false } = {}) {
        if (this._recTimer) {
            clearInterval(this._recTimer);
            this._recTimer = null;
        }
        if (this._levelRaf) {
            cancelAnimationFrame(this._levelRaf);
            this._levelRaf = null;
        }

        const rec = this._recorder;
        this._recorder = null;
        this.isRecording = false;
        this.dom.recBtn.classList.remove('is-recording');
        this.dom.recIcon.textContent = '🎙️';
        this.dom.recLabel.textContent = '开始念 10~15 秒';
        this.dom.levelFill.style.width = '0%';

        if (!rec) return null;

        if (rec.mode === 'mock') {
            if (discard) return null;
            const mock = window.__MOCK_VOICE_STUDIO_WAV__;
            this.draftSample = {
                audioBase64: mock.audioBase64,
                sampleMime: 'audio/wav',
                durationMs: Number(mock.durationMs) || 8500,
                sampleText: this._getActivePromptText()
            };
            this.dom.draftActions.hidden = false;
            this.dom.statusHint.textContent = '✅ 录好啦！先点「▶️ 听听我刚录的」确认清晰，再点「✨ 保存我的专属声线」～';
            return this.draftSample;
        }

        let wav = { base64: '', durationMs: 0 };
        if (rec.mode === 'mediarecorder' && rec.mediaRecorder) {
            await new Promise((resolve) => {
                if (rec.mediaRecorder.state === 'inactive') {
                    resolve();
                    return;
                }
                rec.mediaRecorder.onstop = () => resolve();
                try { rec.mediaRecorder.stop(); } catch (_) { resolve(); }
            });
            try { rec.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            try { rec.meterCtx?.close?.(); } catch (_) {}

            if (!discard && rec.blobParts.length > 0) {
                const mime = rec.mediaRecorder.mimeType || 'audio/webm';
                const blob = new Blob(rec.blobParts, { type: mime });
                try {
                    wav = await decodeAudioBlobToWav16kBase64(blob);
                } catch (_) {
                    wav = { base64: '', durationMs: 0 };
                }
            }
        } else {
            try { rec.processor?.disconnect(); } catch (_) {}
            try { rec.source?.disconnect(); } catch (_) {}
            try { rec.zeroGain?.disconnect(); } catch (_) {}
            try { rec.stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
            try { rec.recCtx?.close(); } catch (_) {}
            if (!discard && rec.chunks?.length) {
                wav = float32PcmToWav16kBase64(mergeFloatChunks(rec.chunks), rec.sampleRate);
            }
        }

        if (discard || !wav.base64 || wav.durationMs < 1800) {
            if (!discard) {
                this.dom.statusHint.textContent = '🎙️ 这段太短啦（不到 2 秒），建议念满 8～15 秒 AI 才学得更像你哦！';
            }
            return null;
        }

        this.draftSample = {
            audioBase64: wav.base64,
            sampleMime: 'audio/wav',
            durationMs: wav.durationMs,
            sampleText: this._getActivePromptText()
        };
        this.dom.draftActions.hidden = false;
        this.dom.statusHint.textContent = `✅ 录好 ${(wav.durationMs / 1000).toFixed(1)} 秒清晰原声！点「▶️ 听听我刚录的」满意后就保存吧～`;
        return this.draftSample;
    }

    async saveDraftSample() {
        if (!this.draftSample?.audioBase64) return null;
        return this.saveSample(this.draftSample);
    }

    async saveSample({ audioBase64, sampleMime = 'audio/wav', durationMs = 10000, sampleText = '' } = {}) {
        if (this.isSaving || !audioBase64) return null;
        const targetRole = this.activeRoleId;
        const charMeta = this._findCharacterMeta(targetRole);
        this.isSaving = true;
        if (this.dom.saveBtn) this.dom.saveBtn.disabled = true;
        this.dom.statusHint.textContent = `☁️ 正在把【${charMeta.name}】的声音样本存到云端…`;

        try {
            const res = await fetch('/api/voice-profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    role: targetRole,
                    displayName: charMeta.name,
                    emoji: charMeta.emoji,
                    fallbackRole: charMeta.fallbackRole,
                    audioBase64,
                    sampleMime,
                    durationMs,
                    sampleText: sampleText || this._getActivePromptText()
                })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data?.ok && data.profile) {
                this.draftSample = null;
                if (this.dom.draftActions) this.dom.draftActions.hidden = true;
                this._applyProfile(data.profile);
                if (data.profile.cloneReady) {
                    this.dom.statusHint.textContent = `🎉 保存并同步成功！快点「🧪 试听 AI 克隆效果」听听【${charMeta.name}】的魔法声线吧！`;
                } else {
                    this.dom.statusHint.textContent = `✅ ${charMeta.name}原声已安全存入云端！等爸爸妈妈在 Cloudflare 后台填好 API Key 就生效啦～`;
                }
                return data.profile;
            }
            this.dom.statusHint.textContent = `⚠️ 保存没有成功（${data?.error || res.status}），可以重录试一下哦～`;
            return null;
        } catch (_) {
            this.dom.statusHint.textContent = '⚠️ 网络开小差啦，稍后再点保存试一次吧～';
            return null;
        } finally {
            this.isSaving = false;
            if (this.dom.saveBtn) this.dom.saveBtn.disabled = false;
        }
    }

    async toggleEnabled(nextEnabled) {
        const targetRole = this.activeRoleId;
        const charMeta = this._findCharacterMeta(targetRole);
        try {
            const res = await fetch('/api/voice-profile/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: targetRole, enabled: Boolean(nextEnabled) })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data?.ok && data.profile) {
                this._applyProfile(data.profile);
                this.dom.statusHint.textContent = data.profile.enabled
                    ? `✨ 已重新开启【${charMeta.name}】的专属声音！`
                    : `⏸️ 已暂停【${charMeta.name}】的专属声音，暂用故事屋默认声线～`;
                return data.profile;
            }
        } catch (_) {}
        return null;
    }

    async playSavedSample() {
        const targetRole = this.activeRoleId;
        const charMeta = this._findCharacterMeta(targetRole);
        try {
            this.dom.statusHint.textContent = '🎧 正在读取云端原声样本…';
            const res = await fetch(`/api/voice-profile/sample?role=${encodeURIComponent(targetRole)}&t=${Date.now()}`, { cache: 'no-store' });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data?.ok && data.audioBase64) {
                this.dom.statusHint.textContent = `🔊 正在播放【${charMeta.name}】的真实原声样本！`;
                await this.audioEngine?.playBase64Audio?.(data.audioBase64, '');
                return true;
            }
            this.dom.statusHint.textContent = 'ℹ️ 还没有保存的原声样本哦～';
        } catch (_) {
            this.dom.statusHint.textContent = '⚠️ 播放原声时网络开小差啦～';
        }
        return false;
    }

    async testClonedVoice() {
        if (this.isTesting) return null;
        const targetRole = this.activeRoleId;
        const charMeta = this._findCharacterMeta(targetRole);
        this.isTesting = true;
        if (this.dom.testCloneBtn) this.dom.testCloneBtn.disabled = true;
        this.dom.statusHint.textContent = `🧪 正在呼叫 AI 声线克隆试听【${charMeta.name}】…`;

        try {
            const sampleText = targetRole === 'pea'
                ? '大家好，我是小豌豆！现在每一本故事书里都是我自己的声音啦！'
                : `大家好，我是${charMeta.name}！现在小豌豆的故事书里都是我自己的声音啦！`;
            const res = await fetch('/api/voice-profile/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    role: targetRole,
                    displayName: charMeta.name,
                    fallbackRole: charMeta.fallbackRole,
                    text: sampleText
                })
            });
            const data = await res.json().catch(() => ({}));
            if (data?.profile) {
                this._applyProfile(data.profile);
            }
            if (data?.message) {
                this.dom.statusHint.textContent = data.message;
            }
            if (data?.audioBase64) {
                await this.audioEngine?.playBase64Audio?.(
                    data.audioBase64,
                    sampleText,
                    charMeta.fallbackRole || 'narrator',
                    { voiceProfileId: targetRole }
                );
            }
            return data;
        } catch (_) {
            this.dom.statusHint.textContent = '⚠️ 试听请求失败，稍后再试一次吧～';
            return null;
        } finally {
            this.isTesting = false;
            if (this.dom.testCloneBtn) this.dom.testCloneBtn.disabled = false;
        }
    }

    async deleteSavedSample() {
        const targetRole = this.activeRoleId;
        const charMeta = this._findCharacterMeta(targetRole);
        try {
            const res = await fetch('/api/voice-profile/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: targetRole })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data?.ok && data.profile) {
                this._applyProfile({
                    ...data.profile,
                    displayName: charMeta.name,
                    emoji: charMeta.emoji,
                    fallbackRole: charMeta.fallbackRole
                });
                this.dom.statusHint.textContent = `🗑️ 已清空【${charMeta.name}】的云端样本，随时可以再录一段新的声音！`;
                return true;
            }
        } catch (_) {}
        return false;
    }
}
