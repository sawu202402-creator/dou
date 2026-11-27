/**
 * storyMailbox.js - 《🪄 魔法画师传声屋》站内语音/文字对话与云端信箱模块
 * 让小豌豆从 iPad 桌面点开故事屋后，随时能直接通过语音（Whisper 转文字）或打字告诉魔法画师想画的新故事、续写或修改，
 * 享受实时温柔真人语音陪聊，并接收 Antigravity 正式画完新页后的语音回信与一键直达！
 */

import { escapeHtml } from './pinyinRenderer.js';

const STORAGE_KEY = 'pea_story_house_mailbox_v1';

const WELCOME_MSG = {
    id: 'welcome_01',
    badgeTitle: '🪄 画师见面礼',
    createdStr: '随时找我聊天',
    text: '嗨小豌豆！我是你的魔法故事画师大姐姐！不管是想新编一本绘本、续写下一页，还是想给主角换衣服或加新台词，都可以按下面大话筒直接说给我听哦！'
};

function nowTimeStr() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${mi}`;
}

function encodePcmChunksToWav16kBase64(chunks, srcSampleRate = 48000) {
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    if (totalLen === 0) return { base64: '', durationSec: 0, maxPeak: 0 };

    const merged = new Float32Array(totalLen);
    let offset = 0;
    let maxPeak = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        for (let i = 0; i < c.length; i++) {
            const a = Math.abs(c[i]);
            if (a > maxPeak) maxPeak = a;
        }
        offset += c.length;
    }

    const targetRate = 16000;
    const ratio = srcSampleRate > targetRate ? (srcSampleRate / targetRate) : 1;
    const outSamples = Math.max(1, Math.floor(totalLen / ratio));
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

    const normGain = (maxPeak > 0.012 && maxPeak < 0.35) ? Math.min(3.2, 0.55 / maxPeak) : 1.0;
    let bytePos = 44;
    for (let i = 0; i < outSamples; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(totalLen, Math.floor((i + 1) * ratio));
        let sum = 0;
        let cnt = 0;
        for (let j = start; j < end; j++) {
            sum += merged[j];
            cnt++;
        }
        const sample = cnt > 0 ? (sum / cnt) * normGain : merged[start] * normGain;
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
    return { base64: btoa(binary), durationSec: totalLen / srcSampleRate, maxPeak };
}

export class StoryMailboxController {
    constructor({
        audioEngine,
        getContext,
        onJumpToBook,
        onBeforeOpen,
        onNewReply
    } = {}) {
        this.audioEngine = audioEngine;
        this.getContext = typeof getContext === 'function' ? getContext : () => ({ view: 'shelf' });
        this.onJumpToBook = typeof onJumpToBook === 'function' ? onJumpToBook : () => {};
        this.onBeforeOpen = typeof onBeforeOpen === 'function' ? onBeforeOpen : () => {};
        this.onNewReply = typeof onNewReply === 'function' ? onNewReply : () => {};

        this.state = this._loadLocalState();
        this.cloudReplies = [];
        this.cloudOnline = false;
        this._cloudUnavailable = false;
        this._syncTimer = null;
        this._knownReplyIds = new Set();

        this.isOpen = false;
        this.isRecording = false;
        this.isTranscribing = false;
        this.isSending = false;
        this._thinkingWishId = null;
        this._playingKey = '';

        this._recorder = null;
        this._recognition = null;
        this._recTimer = null;
        this._recSeconds = 0;
        this._recBaseText = '';
        this._recFinalText = '';

        this.badgeEls = new Set();
        this.dom = {};
    }

    _loadLocalState() {
        const fallback = { wishes: [], readReplyIds: [], welcomePlayed: false };
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return {
                wishes: Array.isArray(parsed.wishes) ? parsed.wishes : [],
                readReplyIds: Array.isArray(parsed.readReplyIds) ? parsed.readReplyIds : [],
                welcomePlayed: Boolean(parsed.welcomePlayed)
            };
        } catch (_) {
            return fallback;
        }
    }

    _saveLocalState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
        } catch (_) {}
    }

    _shouldUseCloudApi() {
        if (typeof window === 'undefined' || typeof fetch !== 'function') return false;
        if (this._cloudUnavailable) return false;
        return window.location.protocol === 'https:' || window.location.protocol === 'http:';
    }

    bindBadgeEl(el) {
        if (el) {
            this.badgeEls.add(el);
            this.refreshBadges();
        }
    }

    init() {
        this._ensureModalDom();
        this.refreshBadges();
        this.syncFromCloud().catch(() => {});
        if (!this._syncTimer && typeof setInterval !== 'undefined') {
            this._syncTimer = setInterval(() => {
                this.syncFromCloud().catch(() => {});
            }, 15000);
        }
    }

    getUnreadReplies() {
        const readSet = new Set(this.state.readReplyIds || []);
        return this.cloudReplies.filter((r) => r && r.id && !readSet.has(r.id));
    }

    getUnreadCount() {
        return this.getUnreadReplies().length;
    }

    refreshBadges() {
        const count = this.getUnreadCount();
        this.badgeEls.forEach((el) => {
            el.hidden = count <= 0;
            el.textContent = count > 9 ? '9+' : String(count);
        });
    }

    _markAllRepliesRead() {
        const readSet = new Set(this.state.readReplyIds || []);
        let changed = false;
        for (const r of this.cloudReplies) {
            if (r?.id && !readSet.has(r.id)) {
                readSet.add(r.id);
                changed = true;
            }
        }
        if (changed) {
            this.state.readReplyIds = Array.from(readSet);
            this._saveLocalState();
            this.refreshBadges();
        }
    }

    _getInspirationChips() {
        const ctx = this.getContext() || {};
        const title = ctx.bookTitle ? `《${ctx.bookTitle}》` : '';
        const pageNum = ctx.pageNumber || 1;
        return [
            { icon: '✨', label: '编一本新绘本', prefix: '我想新编一本故事书，主角是：' },
            {
                icon: '📖',
                label: '续写下一页',
                prefix: title ? `我想给${title}续写下一页：` : '我想续写新的一页故事：'
            },
            {
                icon: '💬',
                label: '改这页台词',
                prefix: title ? `我想改一下${title}第${pageNum}页的画面或台词：` : '我想修改一下故事里的台词：'
            },
            { icon: '🐾', label: '加新小伙伴', prefix: '我想在故事里新加一个小伙伴：' },
            { icon: '🪄', label: '加神奇魔法', prefix: '如果故事里出现这样的魔法一定超酷：' },
            { icon: '👋', label: '跟画师聊天', prefix: '嗨魔法画师！跟你说件好玩的事：' }
        ];
    }

    _ensureModalDom() {
        if (this.dom.overlay) return;

        const overlay = document.createElement('div');
        overlay.id = 'storyMailboxOverlay';
        overlay.className = 'sm-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="sm-modal" role="dialog" aria-modal="true" aria-labelledby="smModalTitle">
                <header class="sm-header">
                    <div class="sm-header-left">
                        <span class="sm-header-avatar" aria-hidden="true">🪄</span>
                        <div class="sm-header-titles">
                            <h2 id="smModalTitle">跟魔法故事画师聊天</h2>
                            <p id="smContextPill" class="sm-context-pill">📚 魔法书架</p>
                        </div>
                    </div>
                    <button type="button" id="smCloseBtn" class="sm-close-btn" aria-label="关闭对话窗口">✕</button>
                </header>

                <div id="smStream" class="sm-stream" aria-live="polite"></div>

                <footer class="sm-composer">
                    <div id="smChipsRow" class="sm-chips-row"></div>
                    <div id="smRecBanner" class="sm-rec-banner" hidden>
                        <span class="sm-rec-dot" aria-hidden="true"></span>
                        <span id="smRecBannerText">正在听小豌豆说话…</span>
                    </div>
                    <div class="sm-input-row">
                        <textarea
                            id="smTextInput"
                            class="sm-textarea"
                            rows="2"
                            maxlength="500"
                            placeholder="点下面大话筒说出你的故事点子，或者直接打字告诉画师大姐姐～"
                        ></textarea>
                    </div>
                    <div class="sm-actions-row">
                        <button type="button" id="smMicBtn" class="sm-mic-btn">
                            <span id="smMicIcon">🎙️</span>
                            <span id="smMicText">点我说话</span>
                        </button>
                        <button type="button" id="smSendBtn" class="sm-send-btn">
                            <span>🚀</span>
                            <span id="smSendText">发送给画师</span>
                        </button>
                    </div>
                    <div id="smStatusHint" class="sm-status-hint">✨ 你说的每一句话，画师都会用心变成新绘本和新漫画哦！</div>
                </footer>
            </div>
        `;

        document.body.appendChild(overlay);

        this.dom = {
            overlay,
            closeBtn: overlay.querySelector('#smCloseBtn'),
            contextPill: overlay.querySelector('#smContextPill'),
            stream: overlay.querySelector('#smStream'),
            chipsRow: overlay.querySelector('#smChipsRow'),
            recBanner: overlay.querySelector('#smRecBanner'),
            recBannerText: overlay.querySelector('#smRecBannerText'),
            textInput: overlay.querySelector('#smTextInput'),
            micBtn: overlay.querySelector('#smMicBtn'),
            micIcon: overlay.querySelector('#smMicIcon'),
            micText: overlay.querySelector('#smMicText'),
            sendBtn: overlay.querySelector('#smSendBtn'),
            sendText: overlay.querySelector('#smSendText'),
            statusHint: overlay.querySelector('#smStatusHint')
        };

        this.dom.closeBtn.addEventListener('click', () => this.close());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.close();
        });

        this.dom.micBtn.addEventListener('click', () => {
            this.audioEngine?.unlockInGesture?.();
            if (this.isRecording) {
                this.stopRecording({ transcribeNow: true });
            } else {
                this.startRecording();
            }
        });

        this.dom.sendBtn.addEventListener('click', () => {
            this.audioEngine?.unlockInGesture?.();
            this.sendWish();
        });

        this.dom.textInput.addEventListener('input', () => this._syncActionButtons());
        this.dom.textInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.audioEngine?.unlockInGesture?.();
                this.sendWish();
            }
        });

        this.dom.stream.addEventListener('click', (e) => {
            const jumpBtn = e.target.closest('.sm-jump-btn');
            if (jumpBtn) {
                this.audioEngine?.unlockInGesture?.();
                const bookId = jumpBtn.getAttribute('data-book-id');
                const pageNumber = Number(jumpBtn.getAttribute('data-page-num') || 1);
                this.close();
                if (bookId) {
                    this.onJumpToBook(bookId, pageNumber);
                }
                return;
            }

            const playBtn = e.target.closest('.sm-voice-btn');
            if (playBtn) {
                this.audioEngine?.unlockInGesture?.();
                const key = playBtn.getAttribute('data-play-key') || '';
                const role = playBtn.getAttribute('data-role') || 'narrator';
                const text = playBtn.getAttribute('data-text') || '';
                this._playVoiceItem(key, text, role);
            }
        });

        this._renderChips();
    }

    _renderChips() {
        if (!this.dom.chipsRow) return;
        const chips = this._getInspirationChips();
        this.dom.chipsRow.innerHTML = chips.map((ch, idx) => `
            <button type="button" class="sm-chip" data-chip-idx="${idx}">
                <span>${escapeHtml(ch.icon)}</span>
                <span>${escapeHtml(ch.label)}</span>
            </button>
        `).join('');

        this.dom.chipsRow.querySelectorAll('.sm-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.getAttribute('data-chip-idx'));
                const chip = chips[idx];
                if (!chip) return;
                this.dom.textInput.value = chip.prefix;
                this.dom.textInput.focus();
                this._syncActionButtons();
            });
        });
    }

    _updateContextPill() {
        if (!this.dom.contextPill) return;
        const ctx = this.getContext() || {};
        if (ctx.view === 'reader' && ctx.bookTitle) {
            const modeLabel = ctx.mode === 'comic' ? '漫画模式' : '绘本模式';
            this.dom.contextPill.textContent = `📖 正在看：《${ctx.bookTitle}》第 ${ctx.pageNumber || 1} 页 · ${modeLabel}`;
        } else {
            this.dom.contextPill.textContent = '📚 魔法书架 · 随时可以点播新故事';
        }
    }

    _syncActionButtons() {
        if (!this.dom.micBtn || !this.dom.sendBtn) return;
        const hasText = Boolean(this.dom.textInput.value.trim());
        this.dom.micBtn.disabled = this.isTranscribing || this.isSending;
        this.dom.sendBtn.disabled = this.isTranscribing || this.isSending || (!hasText && !this.isRecording);
        this.dom.sendText.textContent = this.isRecording ? '说完直发' : (this.isSending ? '发送中…' : '发送给画师');
    }

    _playVoiceItem(key, text, role) {
        if (!text || !this.audioEngine) return;
        if (this._playingKey === key && this.audioEngine.isSpeaking) {
            this.audioEngine.stop();
            this._playingKey = '';
            this._syncPlayingHighlight();
            return;
        }
        this._playingKey = key;
        this._syncPlayingHighlight();
        this.audioEngine.speak(text, role, {
            onEnd: () => {
                if (this._playingKey === key) {
                    this._playingKey = '';
                    this._syncPlayingHighlight();
                }
            }
        });
    }

    _syncPlayingHighlight() {
        if (!this.dom.stream) return;
        this.dom.stream.querySelectorAll('.sm-voice-btn').forEach((btn) => {
            const active = this._playingKey && btn.getAttribute('data-play-key') === this._playingKey;
            btn.classList.toggle('is-playing', Boolean(active));
        });
    }

    open() {
        this._ensureModalDom();
        this.onBeforeOpen();
        this.isOpen = true;
        this._updateContextPill();
        this._renderChips();
        this.dom.overlay.hidden = false;

        const unread = this.getUnreadReplies();
        this._markAllRepliesRead();
        this.renderTimeline();
        this._syncActionButtons();

        this.syncFromCloud().catch(() => {});

        // 若有未读正式回信自动朗读最新一封；否则首次打开自动播欢迎语
        if (unread.length > 0) {
            const newest = unread[unread.length - 1];
            this._playVoiceItem(`reply_${newest.id}`, newest.text, 'narrator');
        } else if (!this.state.welcomePlayed) {
            this.state.welcomePlayed = true;
            this._saveLocalState();
            this._playVoiceItem(WELCOME_MSG.id, WELCOME_MSG.text, 'narrator');
        }
    }

    close() {
        if (!this.dom.overlay) return;
        if (this.isRecording) {
            this.stopRecording({ transcribeNow: false }).catch(() => {});
        }
        this.isOpen = false;
        this.dom.overlay.hidden = true;
        this._playingKey = '';
        this._syncPlayingHighlight();
    }

    renderTimeline() {
        if (!this.dom.stream) return;

        const wishes = [...(this.state.wishes || [])];
        const replies = [...(this.cloudReplies || [])];
        const wishById = new Map(wishes.map((w) => [w.id, w]));

        const timeline = [];
        for (const w of wishes) {
            const baseTs = Number(w.createdAt) || 0;
            timeline.push({ sortTs: baseTs, kind: 'kid_wish', wish: w });
            if (w.instantReplyText) {
                timeline.push({
                    sortTs: baseTs + 1,
                    kind: 'instant_reply',
                    key: `inst_${w.id}`,
                    text: w.instantReplyText,
                    createdStr: w.createdStr || '',
                    isAiLive: w.instantReplyKey === 'ai_live'
                });
            } else if (this._thinkingWishId === w.id) {
                timeline.push({ sortTs: baseTs + 1, kind: 'thinking' });
            }
        }

        for (const r of replies) {
            const quotedWish = r.replyToId ? wishById.get(r.replyToId.split(',')[0].trim()) : null;
            timeline.push({
                sortTs: Number(r.createdAt) || Date.now(),
                kind: 'artist_reply',
                reply: r,
                quotedWish
            });
        }

        timeline.sort((a, b) => a.sortTs - b.sortTs);

        const parts = [];
        parts.push(this._renderArtistBubble({
            playKey: WELCOME_MSG.id,
            badgeClass: 'sm-badge-welcome',
            badgeText: WELCOME_MSG.badgeTitle,
            timeStr: WELCOME_MSG.createdStr,
            text: WELCOME_MSG.text
        }));

        for (const item of timeline) {
            if (item.kind === 'kid_wish') {
                parts.push(this._renderKidBubble(item.wish));
            } else if (item.kind === 'thinking') {
                parts.push(`
                    <div class="sm-row sm-from-artist" id="smThinkingRow">
                        <div class="sm-avatar" aria-hidden="true">🔮</div>
                        <div class="sm-bubble-col">
                            <div class="sm-meta">
                                <span>魔法故事画师</span>
                                <span class="sm-badge sm-badge-live">🧠 正在想点子</span>
                            </div>
                            <div class="sm-bubble sm-bubble-artist">
                                ✨ 正在翻开魔法画本，认真听小豌豆说话…
                            </div>
                        </div>
                    </div>
                `);
            } else if (item.kind === 'instant_reply') {
                parts.push(this._renderArtistBubble({
                    playKey: item.key,
                    badgeClass: item.isAiLive ? 'sm-badge-live' : 'sm-badge-instant',
                    badgeText: item.isAiLive ? '✨ 画师实时陪聊' : '📮 画师收到啦',
                    timeStr: item.createdStr,
                    text: item.text
                }));
            } else if (item.kind === 'artist_reply') {
                const r = item.reply;
                parts.push(this._renderArtistBubble({
                    playKey: `reply_${r.id}`,
                    badgeClass: 'sm-badge-done',
                    badgeText: r.badgeTitle || '🎉 新故事画好啦！',
                    timeStr: r.createdStr || '',
                    text: r.text,
                    isFormal: true,
                    quotedWish: item.quotedWish,
                    bookId: r.bookId || '',
                    pageNumber: r.pageNumber || 1
                }));
            }
        }

        this.dom.stream.innerHTML = parts.join('');
        this.dom.stream.scrollTop = this.dom.stream.scrollHeight;
        this._syncPlayingHighlight();
    }

    _renderArtistBubble({ playKey, badgeClass, badgeText, timeStr, text, isFormal = false, quotedWish = null, bookId = '', pageNumber = 1 }) {
        const quoteHtml = quotedWish
            ? `<div class="sm-quote">🌟 回应你的点子：“${escapeHtml(quotedWish.text)}”</div>`
            : '';
        const jumpHtml = bookId
            ? `<button type="button" class="sm-jump-btn" data-book-id="${escapeHtml(bookId)}" data-page-num="${Number(pageNumber) || 1}">📖 去看看第 ${Number(pageNumber) || 1} 页 👉</button>`
            : '';

        return `
            <div class="sm-row sm-from-artist ${isFormal ? 'sm-is-formal' : ''}">
                <div class="sm-avatar" aria-hidden="true">🪄</div>
                <div class="sm-bubble-col">
                    <div class="sm-meta">
                        <span>魔法故事画师</span>
                        <span class="sm-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
                        <span>${escapeHtml(timeStr)}</span>
                    </div>
                    <div class="sm-bubble sm-bubble-artist">
                        ${quoteHtml}
                        <div class="sm-msg-text">${escapeHtml(text)}</div>
                        <div class="sm-bubble-btns">
                            <button type="button" class="sm-voice-btn" data-play-key="${escapeHtml(playKey)}" data-role="narrator" data-text="${escapeHtml(text)}">
                                🔊 听画师说
                            </button>
                            ${jumpHtml}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    _renderKidBubble(w) {
        const locLabel = w.bookTitle ? `《${w.bookTitle}》P${w.pageNumber || 1}` : '魔法书架';
        const statusHtml = w.status === 'fulfilled'
            ? `<span class="sm-badge sm-badge-done">🌟 已画进书里啦</span>`
            : (w.syncedCloud
                ? `<span class="sm-badge sm-badge-cloud">☁️ 已送达画师</span>`
                : `<span class="sm-badge sm-badge-cloud">📮 本地保存</span>`);

        return `
            <div class="sm-row sm-from-kid">
                <div class="sm-avatar" aria-hidden="true">🐰</div>
                <div class="sm-bubble-col">
                    <div class="sm-meta sm-meta-right">
                        ${statusHtml}
                        <span>📍${escapeHtml(locLabel)}</span>
                        <span>${escapeHtml(w.createdStr || '')}</span>
                    </div>
                    <div class="sm-bubble sm-bubble-kid">
                        <div class="sm-msg-text">${escapeHtml(w.text)}</div>
                        <div class="sm-bubble-btns">
                            <button type="button" class="sm-voice-btn" data-play-key="kid_${escapeHtml(w.id)}" data-role="pea" data-text="${escapeHtml(w.text)}">
                                🔊 读我的话
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /* ==================== 双引擎语音转文字 ==================== */
    async startRecording() {
        if (this.isRecording || this.isTranscribing) return;
        this.audioEngine?.stop?.();

        this._recBaseText = this.dom.textInput.value.trim();
        if (this._recBaseText && !/[：:，,。！？!\s]$/.test(this._recBaseText)) {
            this._recBaseText += '，';
        }
        this._recFinalText = '';

        const canUseMic = Boolean(
            typeof navigator !== 'undefined' &&
            navigator.mediaDevices &&
            typeof navigator.mediaDevices.getUserMedia === 'function' &&
            this._shouldUseCloudApi() &&
            window.__FORCE_BROWSER_SPEECH_REC !== true
        );

        if (canUseMic) {
            await this._startCloudMicRecording();
        } else {
            this._startBrowserSpeechRec();
        }
    }

    async _startCloudMicRecording() {
        try {
            this.dom.statusHint.textContent = '🎙️ 正在打开小话筒，如果弹出授权提示请点“允许”哦…';
            let stream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true }
                });
            } catch (_) {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }

            if (typeof MediaRecorder !== 'undefined') {
                const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
                let chosen = '';
                if (typeof MediaRecorder.isTypeSupported === 'function') {
                    chosen = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
                }
                const mediaRecorder = chosen ? new MediaRecorder(stream, { mimeType: chosen }) : new MediaRecorder(stream);
                const blobParts = [];
                mediaRecorder.ondataavailable = (ev) => {
                    if (ev.data && ev.data.size > 0) blobParts.push(ev.data);
                };
                mediaRecorder.start();
                this._recorder = { mode: 'mediarecorder', stream, mediaRecorder, blobParts, startedAt: Date.now() };
            } else {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                const recCtx = new Ctx();
                if (recCtx.state === 'suspended') await recCtx.resume();
                const source = recCtx.createMediaStreamSource(stream);
                const processor = recCtx.createScriptProcessor(4096, 1, 1);
                const zeroGain = recCtx.createGain();
                zeroGain.gain.value = 0;
                const chunks = [];
                processor.onaudioprocess = (ev) => {
                    if (this.isRecording) chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
                };
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
                    sampleRate: recCtx.sampleRate || 48000,
                    startedAt: Date.now()
                };
            }

            this.isRecording = true;
            this._recSeconds = 0;
            this.dom.micBtn.classList.add('is-recording');
            this.dom.micIcon.textContent = '⏹️';
            this.dom.micText.textContent = '说完点我 (0s)';
            this.dom.recBanner.hidden = false;
            this.dom.recBannerText.textContent = '🎙️ 正在听小豌豆说话！说完点「⏹️ 说完点我」转文字，或直接点「🚀 说完直发」～';
            this._syncActionButtons();

            if (this._recTimer) clearInterval(this._recTimer);
            this._recTimer = setInterval(() => {
                if (!this.isRecording) return;
                this._recSeconds += 1;
                if (this.dom.micText) this.dom.micText.textContent = `说完点我 (${this._recSeconds}s)`;
                if (this._recSeconds >= 25) {
                    this.stopRecording({ transcribeNow: true });
                }
            }, 1000);
        } catch (err) {
            this.isRecording = false;
            const errName = String(err?.name || '');
            if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
                this.dom.statusHint.textContent = '⚠️ 麦克风没被允许哦：点浏览器地址栏开启麦克风，或点输入框按 iPad 键盘左下角 🎤 听写！';
            } else {
                this._startBrowserSpeechRec();
            }
            this._syncActionButtons();
        }
    }

    _startBrowserSpeechRec() {
        const SpeechRec = typeof window !== 'undefined'
            ? (window.SpeechRecognition || window.webkitSpeechRecognition)
            : null;
        if (!SpeechRec) {
            this.dom.statusHint.textContent = '💡 可以点输入框，用 iPad 键盘左下角的小话筒 🎤 说话转文字哦！';
            this.dom.textInput.focus();
            return;
        }
        try {
            const rec = new SpeechRec();
            rec.lang = 'zh-CN';
            rec.continuous = true;
            rec.interimResults = true;
            rec.onstart = () => {
                this.isRecording = true;
                this.dom.micBtn.classList.add('is-recording');
                this.dom.micIcon.textContent = '⏹️';
                this.dom.micText.textContent = '说完点我';
                this.dom.recBanner.hidden = false;
                this.dom.recBannerText.textContent = '🎙️ 正在听小豌豆说话…';
                this._syncActionButtons();
            };
            rec.onresult = (event) => {
                let interim = '';
                let finalAdded = '';
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const t = event.results[i][0]?.transcript || '';
                    if (event.results[i].isFinal) finalAdded += t;
                    else interim += t;
                }
                if (finalAdded) this._recFinalText += finalAdded;
                this.dom.textInput.value = `${this._recBaseText}${this._recFinalText}${interim}`.slice(0, 500);
                this._syncActionButtons();
            };
            rec.onend = () => {
                this.isRecording = false;
                this.dom.micBtn.classList.remove('is-recording');
                this.dom.micIcon.textContent = '🎙️';
                this.dom.micText.textContent = '点我说话';
                this.dom.recBanner.hidden = true;
                this._syncActionButtons();
            };
            this._recognition = rec;
            rec.start();
        } catch (_) {
            this.isRecording = false;
            this.dom.textInput.focus();
            this._syncActionButtons();
        }
    }

    async stopRecording({ transcribeNow = true } = {}) {
        if (this._recTimer) {
            clearInterval(this._recTimer);
            this._recTimer = null;
        }

        if (this._recorder) {
            const rec = this._recorder;
            this._recorder = null;
            this.isRecording = false;
            this.dom.micBtn.classList.remove('is-recording');
            this.dom.recBanner.hidden = true;

            let uploadBody = null;
            let uploadCtype = 'application/octet-stream';
            const elapsedSec = (Date.now() - (rec.startedAt || Date.now())) / 1000;

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

                if (transcribeNow && rec.blobParts.length > 0 && elapsedSec >= 0.2) {
                    const mime = rec.mediaRecorder.mimeType || 'audio/webm';
                    const blob = new Blob(rec.blobParts, { type: mime });
                    if (blob.size > 40) {
                        uploadBody = blob;
                        uploadCtype = mime;
                    }
                }
            } else {
                try { rec.processor.disconnect(); } catch (_) {}
                try { rec.source.disconnect(); } catch (_) {}
                try { rec.zeroGain.disconnect(); } catch (_) {}
                try { rec.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
                try { rec.recCtx.close(); } catch (_) {}

                if (transcribeNow) {
                    const wav = encodePcmChunksToWav16kBase64(rec.chunks, rec.sampleRate);
                    if (wav.base64 && wav.durationSec >= 0.2) {
                        uploadBody = JSON.stringify({ audioBase64: wav.base64 });
                        uploadCtype = 'application/json';
                    }
                }
            }

            if (!transcribeNow || !uploadBody) {
                this.dom.micIcon.textContent = '🎙️';
                this.dom.micText.textContent = '点我说话';
                if (transcribeNow && !uploadBody) {
                    this.dom.statusHint.textContent = '🎙️ 刚才声音太短没录到哦，再点一下「🎙️ 点我说话」大声说出来吧～';
                }
                this._syncActionButtons();
                return '';
            }

            this.isTranscribing = true;
            this.dom.micIcon.textContent = '⏳';
            this.dom.micText.textContent = '识别中…';
            this.dom.statusHint.textContent = '⚡ 正在把小豌豆的声音变成文字…';
            this._syncActionButtons();

            try {
                const res = await fetch('/api/mailbox/transcribe', {
                    method: 'POST',
                    headers: { 'Content-Type': uploadCtype },
                    body: uploadBody
                });
                if (res.status === 404 || res.status === 405 || res.status === 501) {
                    this._cloudUnavailable = true;
                }
                const data = res.ok ? await res.json().catch(() => ({})) : {};
                const recognized = String(data.text || '').trim();
                if (recognized) {
                    this.dom.textInput.value = `${this._recBaseText}${recognized}`.slice(0, 500);
                    this.dom.statusHint.textContent = '✅ 听清啦！可以直接点「🚀 发送给画师」，也可以修改几个字再发～';
                } else {
                    this.dom.statusHint.textContent = '🎙️ 没太听清，再靠近一点说或者打字告诉画师吧～';
                }
                return recognized;
            } catch (_) {
                this.dom.statusHint.textContent = '⚠️ 语音转文字网络开小差啦，可以先打字告诉画师哦～';
                return '';
            } finally {
                this.isTranscribing = false;
                this.dom.micIcon.textContent = '🎙️';
                this.dom.micText.textContent = '点我说话';
                this._syncActionButtons();
            }
        }

        if (this._recognition) {
            this.isRecording = false;
            try { this._recognition.stop(); } catch (_) {}
            this._recognition = null;
            this.dom.micBtn.classList.remove('is-recording');
            this.dom.micIcon.textContent = '🎙️';
            this.dom.micText.textContent = '点我说话';
            this.dom.recBanner.hidden = true;
            this._syncActionButtons();
            return this.dom.textInput.value.trim();
        }
        return '';
    }

    /* ==================== 发送留言 & 实时 AI 陪聊语音回复 ==================== */
    async sendWish() {
        if (this.isSending || this.isTranscribing) return;
        if (this.isRecording) {
            await this.stopRecording({ transcribeNow: true });
        }

        const text = this.dom.textInput.value.trim();
        if (!text) {
            this.dom.statusHint.textContent = '💡 先按大话筒说话，或者打字写出你想画的故事再发送哦！';
            this.dom.textInput.focus();
            return;
        }

        const ctx = this.getContext() || {};
        const wish = {
            id: `wish_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            kidName: '小豌豆',
            bookId: ctx.bookId || '',
            bookTitle: ctx.bookTitle || '',
            pageNumber: ctx.pageNumber || 1,
            mode: ctx.view === 'reader' ? (ctx.mode || 'storybook') : 'shelf',
            text,
            instantReplyKey: '',
            instantReplyText: '',
            status: 'pending',
            syncedCloud: false,
            createdAt: Date.now(),
            createdStr: nowTimeStr()
        };

        this.isSending = true;
        this._thinkingWishId = wish.id;
        this.state.wishes.push(wish);
        this.dom.textInput.value = '';
        this._saveLocalState();
        this._syncActionButtons();
        this.renderTimeline();
        this.dom.statusHint.textContent = '🔮 魔法画师正在认真听你的点子…';

        try {
            let replyText = '';
            let replyKey = 'local_fallback';
            let audioBase64 = '';

            if (this._shouldUseCloudApi()) {
                const res = await fetch('/api/mailbox/wish', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(wish)
                });
                if (res.status === 404 || res.status === 405 || res.status === 501) {
                    this._cloudUnavailable = true;
                } else if (res.ok) {
                    const data = await res.json();
                    if (data && data.ok) {
                        this.cloudOnline = true;
                        wish.syncedCloud = true;
                        replyText = String(data.replyText || '');
                        replyKey = String(data.replyKey || 'ai_live');
                        audioBase64 = String(data.audioBase64 || '');
                        if (Array.isArray(data.replies)) {
                            this.cloudReplies = data.replies;
                        }
                    }
                }
            }

            if (!replyText) {
                replyText = ctx.bookTitle
                    ? `太有想象力啦小豌豆！你说的「${text.slice(0, 26)}」放在《${ctx.bookTitle}》里一定超级精彩，我已经用魔法画笔记下来啦！`
                    : `哇塞小豌豆！你说的「${text.slice(0, 26)}」真像童话里的魔法，我已经记进魔法画本里啦，马上就去帮你画出来！`;
            }

            wish.instantReplyKey = replyKey;
            wish.instantReplyText = replyText;
            this._thinkingWishId = null;
            this._saveLocalState();
            this.renderTimeline();
            this.refreshBadges();

            const playKey = `inst_${wish.id}`;
            this._playingKey = playKey;
            this._syncPlayingHighlight();
            this.audioEngine?.playBase64Audio?.(audioBase64, replyText, 'narrator', {
                onEnd: () => {
                    if (this._playingKey === playKey) {
                        this._playingKey = '';
                        this._syncPlayingHighlight();
                    }
                }
            });

            this.dom.statusHint.textContent = wish.syncedCloud
                ? '☁️ 已同步到云端魔法画本！画师画好后会发语音回信给你哦～'
                : '📮 已记录到本地魔法画本！部署上线后即可同步云端并实时语音陪聊～';
        } catch (_) {
            this._thinkingWishId = null;
            wish.instantReplyKey = 'local_fallback';
            wish.instantReplyText = `收到小豌豆的奇思妙想啦！我已经把你的好点子记在魔法画本里了！`;
            this._saveLocalState();
            this.renderTimeline();
        } finally {
            this.isSending = false;
            this._syncActionButtons();
        }
    }

    async syncFromCloud() {
        if (!this._shouldUseCloudApi()) return null;
        try {
            const unsynced = (this.state.wishes || []).filter((w) => !w.syncedCloud);
            if (unsynced.length > 0) {
                const syncRes = await fetch('/api/mailbox/sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ wishes: unsynced })
                });
                if (syncRes.ok) {
                    unsynced.forEach((w) => { w.syncedCloud = true; });
                    this._saveLocalState();
                }
            }

            const res = await fetch(`/api/mailbox?t=${Date.now()}`, { cache: 'no-store' });
            if (res.status === 404 || res.status === 405 || res.status === 501) {
                this._cloudUnavailable = true;
                return null;
            }
            if (!res.ok) return null;
            const data = await res.json();
            if (!data || !data.ok) {
                if (data?.error === 'mailbox_binding_unavailable') this._cloudUnavailable = true;
                return null;
            }

            this.cloudOnline = true;
            const cloudWishes = Array.isArray(data.wishes) ? data.wishes : [];
            const cloudReplies = Array.isArray(data.replies) ? data.replies : [];

            const byId = new Map((this.state.wishes || []).map((w) => [w.id, w]));
            for (const cw of cloudWishes) {
                const existing = byId.get(cw.id) || {};
                byId.set(cw.id, { ...existing, ...cw, syncedCloud: true });
            }
            this.state.wishes = Array.from(byId.values()).sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
            this.cloudReplies = cloudReplies;

            const readSet = new Set(this.state.readReplyIds || []);
            const newlyArrived = cloudReplies.filter((r) => r?.id && !readSet.has(r.id) && !this._knownReplyIds.has(r.id));
            cloudReplies.forEach((r) => { if (r?.id) this._knownReplyIds.add(r.id); });

            if (this.isOpen) {
                this._markAllRepliesRead();
                this.renderTimeline();
            } else if (newlyArrived.length > 0) {
                this.onNewReply(newlyArrived[newlyArrived.length - 1]);
            }

            this._saveLocalState();
            this.refreshBadges();
            return data;
        } catch (_) {
            return null;
        }
    }
}
