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
        getBooks,
        loadBook,
        onJumpToBook,
        onBeforeOpen,
        onNewReply,
        onPatrolChange
    } = {}) {
        this.audioEngine = audioEngine;
        this.getContext = typeof getContext === 'function' ? getContext : () => ({ view: 'shelf' });
        this.getBooks = typeof getBooks === 'function' ? getBooks : () => [];
        this.loadBook = typeof loadBook === 'function' ? loadBook : async () => null;
        this.onJumpToBook = typeof onJumpToBook === 'function' ? onJumpToBook : () => {};
        this.onBeforeOpen = typeof onBeforeOpen === 'function' ? onBeforeOpen : () => {};
        this.onNewReply = typeof onNewReply === 'function' ? onNewReply : () => {};
        this.onPatrolChange = typeof onPatrolChange === 'function' ? onPatrolChange : () => {};

        this.state = this._loadLocalState();
        this.cloudReplies = [];
        this.cloudOnline = false;
        this._cloudUnavailable = false;
        this._syncTimer = null;
        this._knownReplyIds = new Set();

        this.patrol = {
            enabled: false,
            updatedAt: 0,
            updatedBy: '',
            watcherLastSeenAt: 0,
            watcherOnline: false,
            expiresAt: 0,
            remainingMinutes: 0
        };
        this._patrolBusy = false;
        this._lastRenderedFingerprint = '';
        this.editTarget = {
            scope: 'new_book',
            bookId: '',
            bookTitle: '',
            pageNumber: 1,
            panelNumber: 0,
            mode: 'shelf',
            actionType: 'general',
            characterId: '',
            characterName: '',
            characterEmoji: '',
            previewImage: '',
            pageTitle: '',
            snippet: ''
        };
        this._activeBookData = null;
        this._bookDataSeq = 0;
        this._dispatchBusy = false;
        this._dispatchedWishKey = '';

        this.isOpen = false;
        this.isRecording = false;
        this.isTranscribing = false;
        this.isSending = false;
        this._thinkingWishId = null;
        this._playingKey = '';
        this._sendLock = false;
        this._announcedReplyIds = new Set();

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
                if (typeof document !== 'undefined' && document.hidden) return;
                this.syncFromCloud().catch(() => {});
            }, 15000);
        }
        if (typeof document !== 'undefined' && !this._onVisibilityChange) {
            this._onVisibilityChange = () => {
                if (document.visibilityState === 'visible') {
                    this.syncFromCloud().catch(() => {});
                }
            };
            document.addEventListener('visibilitychange', this._onVisibilityChange);
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
        const t = this.editTarget || {};
        if (t.bookId) {
            const title = t.bookTitle || '这本书';
            const pageNum = t.pageNumber || 1;
            const panelText = t.panelNumber > 0 ? `第${t.panelNumber}格` : '';
            const loc = `《${title}》第${pageNum}页${panelText}`;
            const who = t.characterName ? `里的${t.characterName}` : '';
            return [
                { icon: '🎨', label: '改这幅画', actionType: 'art', prefix: `我想把${loc}${who}的画面改成：` },
                { icon: '💬', label: '改台词', actionType: 'dialogue', prefix: `我想把${loc}${who}说的话改成：` },
                { icon: '🔊', label: '改声音', actionType: 'voice', prefix: `我觉得${loc}${who}的声音可以改成：` },
                { icon: '➕', label: '续写下一页', actionType: 'next_page', prefix: `我想给《${title}》续写下一页：` },
                { icon: '🐾', label: '加小伙伴', actionType: 'art', prefix: `我想在${loc}新加一个小伙伴：` }
            ];
        }
        return [
            { icon: '✨', label: '编一本新绘本', actionType: 'general', prefix: '我想新编一本故事书，主角是：' },
            { icon: '🐾', label: '加新小伙伴', actionType: 'art', prefix: '我想在故事里新加一个小伙伴：' },
            { icon: '🪄', label: '加神奇魔法', actionType: 'art', prefix: '如果故事里出现这样的魔法一定超酷：' },
            { icon: '👋', label: '跟画师聊天', actionType: 'general', prefix: '嗨魔法画师！跟你说件好玩的事：' }
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

                <div id="smPatrolBar" class="sm-patrol-bar is-off">
                    <div class="sm-patrol-info">
                        <span id="smPatrolDot" class="sm-patrol-dot" aria-hidden="true"></span>
                        <div class="sm-patrol-texts">
                            <div id="smPatrolTitle" class="sm-patrol-title">🌙 画师自动巡检：已关闭</div>
                            <div id="smPatrolSub" class="sm-patrol-sub">平时零消耗休息中；小豌豆一发点子会自动唤醒画师</div>
                        </div>
                    </div>
                    <button type="button" id="smPatrolSwitch" class="sm-switch" role="switch" aria-checked="false" aria-label="开启或关闭画师自动巡检">
                        <span class="sm-switch-thumb"></span>
                    </button>
                </div>

                <div id="smTargetPanel" class="sm-target-panel">
                    <div id="smBookPicker" class="sm-book-picker" role="tablist" aria-label="选择要聊或修改的故事书"></div>
                    <div id="smTargetCard" class="sm-target-card" hidden></div>
                </div>

                <div id="smStream" class="sm-stream" aria-live="polite"></div>

                <footer class="sm-composer">
                    <div id="smChipsRow" class="sm-chips-row"></div>
                    <div id="smCharChipsRow" class="sm-char-chips-row" hidden></div>
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
                    <div id="smDispatchBar" class="sm-dispatch-bar" hidden>
                        <span id="smDispatchText" class="sm-dispatch-text">💬 还可以继续补充哦！聊完点右边立刻开工（或等 40 秒自动开画）</span>
                        <button type="button" id="smDispatchBtn" class="sm-dispatch-btn">🎨 说好啦，立刻开工</button>
                    </div>
                    <div id="smWakePrompt" class="sm-wake-prompt" hidden>
                        <span>🌙 点子已存好，画师正在休息中～</span>
                        <button type="button" id="smWakeNowBtn" class="sm-wake-btn">✨ 召唤画师立刻来画</button>
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
            patrolBar: overlay.querySelector('#smPatrolBar'),
            patrolTitle: overlay.querySelector('#smPatrolTitle'),
            patrolSub: overlay.querySelector('#smPatrolSub'),
            patrolSwitch: overlay.querySelector('#smPatrolSwitch'),
            targetPanel: overlay.querySelector('#smTargetPanel'),
            bookPicker: overlay.querySelector('#smBookPicker'),
            targetCard: overlay.querySelector('#smTargetCard'),
            stream: overlay.querySelector('#smStream'),
            chipsRow: overlay.querySelector('#smChipsRow'),
            charChipsRow: overlay.querySelector('#smCharChipsRow'),
            recBanner: overlay.querySelector('#smRecBanner'),
            recBannerText: overlay.querySelector('#smRecBannerText'),
            textInput: overlay.querySelector('#smTextInput'),
            micBtn: overlay.querySelector('#smMicBtn'),
            micIcon: overlay.querySelector('#smMicIcon'),
            micText: overlay.querySelector('#smMicText'),
            sendBtn: overlay.querySelector('#smSendBtn'),
            sendText: overlay.querySelector('#smSendText'),
            dispatchBar: overlay.querySelector('#smDispatchBar'),
            dispatchText: overlay.querySelector('#smDispatchText'),
            dispatchBtn: overlay.querySelector('#smDispatchBtn'),
            wakePrompt: overlay.querySelector('#smWakePrompt'),
            wakeNowBtn: overlay.querySelector('#smWakeNowBtn'),
            statusHint: overlay.querySelector('#smStatusHint')
        };

        this.dom.closeBtn.addEventListener('click', () => this.close());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.close();
        });

        this.dom.patrolSwitch?.addEventListener('click', () => {
            this.audioEngine?.unlockInGesture?.();
            this.togglePatrol();
        });

        this.dom.wakeNowBtn?.addEventListener('click', () => {
            this.audioEngine?.unlockInGesture?.();
            this.setPatrolEnabled(true);
        });

        this.dom.dispatchBtn?.addEventListener('click', () => {
            this.audioEngine?.unlockInGesture?.();
            this.dispatchNow();
        });

        this.dom.bookPicker?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-pick-book]');
            if (!btn) return;
            const pickId = btn.getAttribute('data-pick-book') || '';
            if (!pickId) {
                this._setEditTarget({ scope: 'new_book', bookId: '' });
                return;
            }
            const ctx = this.getContext() || {};
            if (ctx.view === 'reader' && ctx.bookId === pickId) {
                this._setEditTarget({
                    scope: 'page',
                    bookId: pickId,
                    bookTitle: ctx.bookTitle,
                    pageNumber: ctx.pageNumber || 1,
                    mode: ctx.mode || 'storybook'
                });
            } else {
                this._setEditTarget({
                    scope: 'page',
                    bookId: pickId,
                    pageNumber: 1
                });
            }
        });

        this.dom.targetCard?.addEventListener('click', (e) => {
            const pageBtn = e.target.closest('[data-pick-page]');
            if (pageBtn && this.editTarget.bookId) {
                const nextPage = Math.max(1, Number(pageBtn.getAttribute('data-pick-page')) || 1);
                this.editTarget.pageNumber = nextPage;
                this.editTarget.panelNumber = 0;
                this.editTarget.scope = 'page';
                this.editTarget.characterId = '';
                this.editTarget.characterName = '';
                this.editTarget.characterEmoji = '';
                this._syncTargetBookData();
                return;
            }
            const panelBtn = e.target.closest('[data-pick-panel]');
            if (panelBtn && this.editTarget.bookId) {
                const nextPanel = Math.max(0, Number(panelBtn.getAttribute('data-pick-panel')) || 0);
                this.editTarget.panelNumber = nextPanel;
                this.editTarget.scope = nextPanel > 0 ? 'panel' : 'page';
                if (nextPanel > 0) this.editTarget.mode = 'comic';
                this._syncTargetBookData();
            }
        });

        this.dom.charChipsRow?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-char-id]');
            if (!btn) return;
            const cid = btn.getAttribute('data-char-id') || '';
            const chars = this._activeBookData?.characters || {};
            const ch = chars[cid];
            if (!ch) return;
            if (this.editTarget.characterId === cid) {
                this.editTarget.characterId = '';
                this.editTarget.characterName = '';
                this.editTarget.characterEmoji = '';
            } else {
                this.editTarget.characterId = cid;
                this.editTarget.characterName = ch.name || cid;
                this.editTarget.characterEmoji = ch.emoji || '';
            }
            this._refreshTargetUi();
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
        this._renderPatrolBar();
    }

    _applyPatrolState(rawPatrol) {
        if (!rawPatrol || typeof rawPatrol !== 'object') return;
        this.patrol = {
            enabled: Boolean(rawPatrol.enabled),
            updatedAt: Number(rawPatrol.updatedAt) || 0,
            updatedBy: String(rawPatrol.updatedBy || ''),
            watcherLastSeenAt: Number(rawPatrol.watcherLastSeenAt) || 0,
            watcherOnline: Boolean(rawPatrol.watcherOnline),
            expiresAt: Number(rawPatrol.expiresAt) || 0,
            remainingMinutes: Number(rawPatrol.remainingMinutes) || 0
        };
        if (this.patrol.enabled && this.dom.wakePrompt) {
            this.dom.wakePrompt.hidden = true;
        }
        this._renderPatrolBar();
        this.onPatrolChange(this.patrol);
    }

    _renderPatrolBar() {
        const bar = this.dom.patrolBar;
        const titleEl = this.dom.patrolTitle;
        const subEl = this.dom.patrolSub;
        const swEl = this.dom.patrolSwitch;
        if (!bar || !titleEl || !subEl || !swEl) return;

        const enabled = Boolean(this.patrol.enabled);
        const watcherOnline = Boolean(this.patrol.watcherOnline);
        const remainingMinutes = Number(this.patrol.remainingMinutes) || 0;

        bar.classList.toggle('is-on', enabled);
        bar.classList.toggle('is-off', !enabled);
        bar.classList.toggle('is-watcher-offline', enabled && !watcherOnline);

        swEl.setAttribute('aria-checked', String(enabled));
        swEl.disabled = this._patrolBusy;

        if (enabled) {
            titleEl.textContent = '✨ 画师自动巡检：已开启';
            const ttlNote = remainingMinutes > 0 ? `（约 ${remainingMinutes} 分钟无新留言自动休息）` : '';
            subEl.textContent = watcherOnline
                ? `电脑画师正在值守，发完点子会自动动笔${ttlNote}`
                : '开关已打开，等待电脑端零能耗哨兵上线接收留言…';
        } else {
            titleEl.textContent = '🌙 画师自动巡检：已关闭';
            subEl.textContent = watcherOnline
                ? '平时零消耗休息中；小豌豆一发点子会自动唤醒画师 · 电脑哨兵待命中'
                : '平时零消耗休息中；小豌豆一发点子会自动打开巡检';
        }
    }

    async setPatrolEnabled(enabled) {
        if (this._patrolBusy) return null;
        if (!this._shouldUseCloudApi()) return null;

        this._patrolBusy = true;
        this._renderPatrolBar();
        this.onPatrolChange(this.patrol);

        try {
            const res = await fetch('/api/mailbox/patrol', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: Boolean(enabled), source: 'web' })
            });
            const data = res.ok ? await res.json().catch(() => null) : null;
            if (res.ok && data?.ok && data.patrol) {
                this._applyPatrolState(data.patrol);
                if (this.isOpen && this.dom.statusHint) {
                    this.dom.statusHint.textContent = data.patrol.enabled
                        ? '✨ 已开启画师自动巡检！发完点子画师就会立刻收到哦～'
                        : '🌙 已关闭画师自动巡检，平时零消耗静静休息中～';
                }
                return data.patrol;
            }
            if (this.isOpen && this.dom.statusHint) {
                this.dom.statusHint.textContent = '⚠️ 切换巡检开关暂时没成功，请稍后再试一次哦～';
            }
            return null;
        } catch (_) {
            if (this.isOpen && this.dom.statusHint) {
                this.dom.statusHint.textContent = '⚠️ 网络开小差啦，巡检开关还没切换成功哦～';
            }
            return null;
        } finally {
            this._patrolBusy = false;
            this._renderPatrolBar();
            this.onPatrolChange(this.patrol);
        }
    }

    async togglePatrol() {
        return this.setPatrolEnabled(!this.patrol.enabled);
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
                this.editTarget.actionType = chip.actionType || 'general';
                this.dom.textInput.value = chip.prefix;
                this.dom.textInput.focus();
                this._syncActionButtons();
            });
        });
    }

    _setEditTarget(preset = null) {
        const books = this.getBooks() || [];
        if (preset && preset.bookId) {
            const manifestEntry = books.find((b) => b.id === preset.bookId);
            const panelNumber = Math.max(0, Number(preset.panelNumber) || 0);
            this.editTarget = {
                scope: preset.scope || (panelNumber > 0 ? 'panel' : 'page'),
                bookId: preset.bookId,
                bookTitle: preset.bookTitle || manifestEntry?.title || '',
                pageNumber: Math.max(1, Number(preset.pageNumber) || 1),
                panelNumber,
                mode: preset.mode || (panelNumber > 0 ? 'comic' : (manifestEntry?.defaultMode || 'storybook')),
                actionType: preset.actionType || 'general',
                characterId: preset.characterId || '',
                characterName: preset.characterName || '',
                characterEmoji: preset.characterEmoji || '',
                previewImage: preset.previewImage || manifestEntry?.cover || '',
                pageTitle: preset.pageTitle || '',
                snippet: preset.snippet || ''
            };
        } else {
            this.editTarget = {
                scope: 'new_book',
                bookId: '',
                bookTitle: '',
                pageNumber: 1,
                panelNumber: 0,
                mode: 'shelf',
                actionType: 'general',
                characterId: '',
                characterName: '',
                characterEmoji: '',
                previewImage: '',
                pageTitle: '',
                snippet: ''
            };
        }
        this._syncTargetBookData();
    }

    async _syncTargetBookData() {
        const targetBookId = this.editTarget.bookId;
        if (!targetBookId) {
            this._bookDataSeq++;
            this._activeBookData = null;
            this._refreshTargetUi();
            return;
        }

        if (this._activeBookData?.id !== targetBookId) {
            this._activeBookData = null;
        }
        this._refreshTargetUi();

        const seq = ++this._bookDataSeq;
        const loaded = await this.loadBook(targetBookId).catch(() => null);
        if (seq !== this._bookDataSeq || this.editTarget.bookId !== targetBookId) return;
        this._activeBookData = loaded;

        if (loaded && Array.isArray(loaded.pages) && loaded.pages.length > 0) {
            const maxPages = loaded.pages.length;
            const pageNum = Math.max(1, Math.min(maxPages, this.editTarget.pageNumber || 1));
            const pageObj = loaded.pages[pageNum - 1];
            const panels = Array.isArray(pageObj?.panels) ? pageObj.panels : [];
            const panelNum = this.editTarget.panelNumber > 0 && panels.length > 0
                ? Math.min(panels.length, this.editTarget.panelNumber)
                : 0;
            const panelObj = panelNum > 0 ? panels[panelNum - 1] : null;

            this.editTarget.pageNumber = pageNum;
            this.editTarget.panelNumber = panelNum;
            if (panelNum > 0) this.editTarget.scope = 'panel';
            this.editTarget.bookTitle = loaded.title || this.editTarget.bookTitle;
            this.editTarget.pageTitle = pageObj?.title || '';
            this.editTarget.previewImage = panelObj?.image || pageObj?.illustration || loaded.cover || this.editTarget.previewImage;

            let snippet = '';
            if (this.editTarget.characterId) {
                const bubblePool = panelObj?.bubbles || panels.flatMap((p) => p.bubbles || []);
                const charBubble = bubblePool.find((b) => b.characterId === this.editTarget.characterId);
                if (charBubble?.text) snippet = charBubble.text;
            }
            if (!snippet && panelObj) {
                snippet = panelObj.caption || panelObj.bubbles?.[0]?.text || '';
            }
            if (!snippet) {
                snippet = pageObj?.storyParagraphs?.[0]?.text || '';
            }
            this.editTarget.snippet = String(snippet).slice(0, 80);
        }

        this._refreshTargetUi();
    }

    _refreshTargetUi() {
        this._renderBookPicker();
        this._renderTargetCard();
        this._renderCharChips();
        this._renderChips();
        this._updateContextPill();
    }

    _renderBookPicker() {
        if (!this.dom.bookPicker) return;
        const books = this.getBooks() || [];
        const activeId = this.editTarget.bookId || '';
        const newBookActive = !activeId;
        const itemsHtml = [
            `<button type="button" class="sm-book-pick-btn ${newBookActive ? 'is-active' : ''}" data-pick-book="" role="tab" aria-selected="${newBookActive}">✨ 编新书</button>`,
            ...books.map((b) => {
                const active = b.id === activeId;
                const thumbHtml = b.cover
                    ? `<img src="${escapeHtml(b.cover)}" alt="" class="sm-book-thumb" loading="lazy" decoding="async">`
                    : `<span>${escapeHtml(b.emoji || '📖')}</span>`;
                return `
                    <button type="button" class="sm-book-pick-btn ${active ? 'is-active' : ''}" data-pick-book="${escapeHtml(b.id)}" role="tab" aria-selected="${active}">
                        ${thumbHtml}
                        <span>${escapeHtml(b.title)}</span>
                    </button>
                `;
            })
        ];
        this.dom.bookPicker.innerHTML = itemsHtml.join('');
    }

    _renderTargetCard() {
        const card = this.dom.targetCard;
        if (!card) return;
        const t = this.editTarget;
        if (!t.bookId) {
            card.hidden = true;
            card.innerHTML = '';
            return;
        }
        card.hidden = false;

        const manifestEntry = (this.getBooks() || []).find((b) => b.id === t.bookId);
        const totalPages = this._activeBookData?.pages?.length || Number(manifestEntry?.pageCount) || 1;
        const pageObj = this._activeBookData?.pages?.[t.pageNumber - 1];
        const panels = Array.isArray(pageObj?.panels) ? pageObj.panels : [];

        const pagePills = [];
        for (let p = 1; p <= totalPages; p++) {
            const act = p === t.pageNumber ? 'is-active' : '';
            pagePills.push(`<button type="button" class="sm-mini-pill ${act}" data-pick-page="${p}">第${p}页</button>`);
        }

        const panelPills = [];
        if (panels.length > 0) {
            panelPills.push('<span class="sm-mini-sep">|</span>');
            panelPills.push(`<button type="button" class="sm-mini-pill ${t.panelNumber === 0 ? 'is-active' : ''}" data-pick-panel="0">整页</button>`);
            for (let k = 1; k <= panels.length; k++) {
                panelPills.push(`<button type="button" class="sm-mini-pill ${t.panelNumber === k ? 'is-active' : ''}" data-pick-panel="${k}">第${k}格</button>`);
            }
        }

        const thumbHtml = t.previewImage
            ? `<img src="${escapeHtml(t.previewImage)}" alt="" class="sm-target-thumb">`
            : '';
        const panelLabel = t.panelNumber > 0 ? ` · 第 ${t.panelNumber} 格` : '';
        const charLabel = t.characterName ? ` · ${t.characterEmoji || ''}${t.characterName}` : '';
        const titleLabel = t.pageTitle ? `（${t.pageTitle}）` : '';

        card.innerHTML = `
            ${thumbHtml}
            <div class="sm-target-body">
                <div class="sm-target-summary">📍 《${escapeHtml(t.bookTitle)}》第 ${t.pageNumber} 页${escapeHtml(panelLabel)}${escapeHtml(charLabel)}${escapeHtml(titleLabel)}</div>
                <div class="sm-target-pills-row">
                    ${pagePills.join('')}
                    ${panelPills.join('')}
                </div>
            </div>
        `;
    }

    _renderCharChips() {
        const row = this.dom.charChipsRow;
        if (!row) return;
        const charsMap = this._activeBookData?.characters;
        if (!this.editTarget.bookId || !charsMap || typeof charsMap !== 'object') {
            row.hidden = true;
            row.innerHTML = '';
            return;
        }

        const orderedIds = [];
        const seen = new Set();
        const pageObj = this._activeBookData?.pages?.[this.editTarget.pageNumber - 1];
        const panels = Array.isArray(pageObj?.panels) ? pageObj.panels : [];
        const focusPanels = this.editTarget.panelNumber > 0 && panels[this.editTarget.panelNumber - 1]
            ? [panels[this.editTarget.panelNumber - 1], ...panels]
            : panels;

        for (const pan of focusPanels) {
            for (const b of (pan?.bubbles || [])) {
                if (b.characterId && charsMap[b.characterId] && !seen.has(b.characterId)) {
                    seen.add(b.characterId);
                    orderedIds.push(b.characterId);
                }
            }
        }
        for (const cid of Object.keys(charsMap)) {
            if (!seen.has(cid)) {
                seen.add(cid);
                orderedIds.push(cid);
            }
        }

        if (orderedIds.length === 0) {
            row.hidden = true;
            row.innerHTML = '';
            return;
        }

        row.hidden = false;
        const pillsHtml = orderedIds.map((cid) => {
            const ch = charsMap[cid];
            const active = this.editTarget.characterId === cid ? 'is-active' : '';
            return `<button type="button" class="sm-char-chip ${active}" data-char-id="${escapeHtml(cid)}">${escapeHtml(ch.emoji || '💬')} ${escapeHtml(ch.name || cid)}</button>`;
        }).join('');
        row.innerHTML = `<span class="sm-char-label">指给画师看：</span>${pillsHtml}`;
    }

    _buildWishTargetPayload() {
        const t = this.editTarget || {};
        return {
            scope: t.bookId ? (t.panelNumber > 0 ? 'panel' : 'page') : 'new_book',
            panelNumber: Number(t.panelNumber) || 0,
            actionType: t.actionType || 'general',
            characterId: t.characterId || '',
            characterName: t.characterName || '',
            characterEmoji: t.characterEmoji || '',
            previewImage: t.previewImage || '',
            pageTitle: t.pageTitle || '',
            snippet: t.snippet || ''
        };
    }

    _buildPageContextForAi() {
        const bookData = this._activeBookData;
        const t = this.editTarget || {};
        if (!t.bookId || !bookData) return null;
        const pageObj = bookData.pages?.[(t.pageNumber || 1) - 1];
        if (!pageObj) return null;

        const charsMap = bookData.characters || {};
        const panels = Array.isArray(pageObj.panels) ? pageObj.panels : [];
        const panelObj = t.panelNumber > 0 ? panels[t.panelNumber - 1] : null;
        const storySummary = (pageObj.storyParagraphs || []).map((p) => p.text).join(' ').slice(0, 220);

        const targetPanels = panelObj ? [panelObj] : panels;
        const bubbleList = [];
        const seenChars = new Set();
        const charList = [];
        for (const pan of targetPanels) {
            for (const b of (pan?.bubbles || [])) {
                const ch = charsMap[b.characterId];
                const charName = ch?.name || b.characterId || '角色';
                if (b.characterId && !seenChars.has(b.characterId)) {
                    seenChars.add(b.characterId);
                    charList.push({ name: charName, emoji: ch?.emoji || '' });
                }
                if (b.text && bubbleList.length < 5) {
                    bubbleList.push({ characterName: charName, text: b.text });
                }
            }
        }

        return {
            pageTitle: pageObj.title || '',
            storySummary,
            panelCaption: panelObj?.caption || panels[0]?.caption || '',
            characters: charList,
            bubbles: bubbleList
        };
    }

    _renderDispatchBar() {
        const bar = this.dom.dispatchBar;
        const textEl = this.dom.dispatchText;
        const btnEl = this.dom.dispatchBtn;
        if (!bar || !textEl || !btnEl) return;

        const pending = (this.state.wishes || []).filter((w) => w.syncedCloud && w.status === 'pending');
        if (pending.length === 0 || !this._shouldUseCloudApi()) {
            bar.hidden = true;
            return;
        }

        bar.hidden = false;
        const latestId = pending[pending.length - 1]?.id || '';
        const alreadyDispatched = Boolean(latestId && this._dispatchedWishKey === latestId);
        btnEl.disabled = this._dispatchBusy || alreadyDispatched;
        if (alreadyDispatched) {
            btnEl.textContent = '🚀 已通知开工';
            textEl.textContent = '✨ 魔法画师已经拿起画笔，马上就变到书架上啦！';
        } else {
            btnEl.textContent = '🎨 说好啦，立刻开工';
            textEl.textContent = '💬 还可以继续补充哦！聊完点右边立刻开工（或等 40 秒自动开画）';
        }
    }

    async dispatchNow() {
        if (this._dispatchBusy || !this._shouldUseCloudApi()) return null;
        const pending = (this.state.wishes || []).filter((w) => w.syncedCloud && w.status === 'pending');
        const latestId = pending[pending.length - 1]?.id || '';

        this._dispatchBusy = true;
        this._renderDispatchBar();
        try {
            const res = await fetch('/api/mailbox/dispatch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const data = res.ok ? await res.json().catch(() => null) : null;
            if (res.ok && data?.ok) {
                if (data.patrol && typeof data.patrol === 'object') {
                    this._applyPatrolState(data.patrol);
                }
                if (latestId) this._dispatchedWishKey = latestId;
                if (this.dom.statusHint) {
                    this.dom.statusHint.textContent = '🚀 魔法画师已经收到确认清单，马上动笔画新页面啦！';
                }
                return data;
            }
            return null;
        } catch (_) {
            return null;
        } finally {
            this._dispatchBusy = false;
            this._renderDispatchBar();
        }
    }

    _updateContextPill() {
        if (!this.dom.contextPill) return;
        const t = this.editTarget || {};
        if (t.bookId && t.bookTitle) {
            const modeLabel = t.mode === 'comic' ? '漫画模式' : '绘本模式';
            const panelLabel = t.panelNumber > 0 ? ` · 第 ${t.panelNumber} 格` : '';
            const charLabel = t.characterName ? ` · ${t.characterName}` : '';
            this.dom.contextPill.textContent = `✏️ 选中：《${t.bookTitle}》第 ${t.pageNumber || 1} 页${panelLabel}${charLabel} · ${modeLabel}`;
        } else {
            this.dom.contextPill.textContent = '✨ 新编一本故事书 · 点上面书封可切换修改旧书';
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

    markBookRepliesAnnounced(bookId = '') {
        const now = Date.now();
        for (const r of (this.cloudReplies || [])) {
            if (!r || !r.id) continue;
            const matchBook = Boolean(bookId && r.bookId === bookId);
            const isRecent = (Number(r.createdAt) || 0) >= (now - 180_000);
            if (matchBook || isRecent) {
                this._announcedReplyIds.add(r.id);
            }
        }
    }

    open(presetTarget = null) {
        this._ensureModalDom();
        if (this.isOpen) {
            if (presetTarget && typeof presetTarget === 'object') {
                this._setEditTarget(presetTarget);
            }
            return;
        }
        this.onBeforeOpen();
        this.isOpen = true;

        if (presetTarget && typeof presetTarget === 'object') {
            this._setEditTarget(presetTarget);
        } else {
            const ctx = this.getContext() || {};
            if (ctx.view === 'reader' && ctx.bookId) {
                this._setEditTarget({
                    scope: 'page',
                    bookId: ctx.bookId,
                    bookTitle: ctx.bookTitle,
                    pageNumber: ctx.pageNumber || 1,
                    mode: ctx.mode || 'storybook'
                });
            } else {
                this._setEditTarget({ scope: 'new_book', bookId: '' });
            }
        }

        this._renderPatrolBar();
        this._renderDispatchBar();
        this.dom.overlay.hidden = false;

        const unread = this.getUnreadReplies();
        this._markAllRepliesRead();
        this.renderTimeline({ forceScroll: true });
        this._syncActionButtons();

        this.syncFromCloud({ suppressNewReplyCallback: true }).catch(() => {});

        const unannounced = unread.filter((r) => r?.id && !this._announcedReplyIds.has(r.id));
        if (unannounced.length > 0) {
            const newest = unannounced[unannounced.length - 1];
            unannounced.forEach((r) => this._announcedReplyIds.add(r.id));
            this._playVoiceItem(`reply_${newest.id}`, newest.text, 'narrator');
        } else if (!this.state.welcomePlayed && !this.audioEngine?.isSpeaking) {
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

    _getTimelineFingerprint() {
        const wPart = (this.state.wishes || [])
            .map((w) => `${w.id}:${w.status || ''}:${w.syncedCloud ? 1 : 0}:${(w.instantReplyText || '').length}`)
            .join('|');
        const rPart = (this.cloudReplies || [])
            .map((r) => `${r.id}:${r.bookId || ''}:${r.pageNumber || 1}:${(r.text || '').length}`)
            .join('|');
        return `${this._thinkingWishId || ''}#${wPart}#${rPart}`;
    }

    renderTimeline({ forceScroll = false } = {}) {
        const stream = this.dom.stream;
        if (!stream) return;

        const prevScrollTop = stream.scrollTop;
        const wasNearBottom = (stream.scrollHeight - stream.scrollTop - stream.clientHeight) < 72;

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

        this._lastRenderedFingerprint = this._getTimelineFingerprint();
        stream.innerHTML = parts.join('');
        if (forceScroll || wasNearBottom) {
            stream.scrollTop = stream.scrollHeight;
        } else {
            stream.scrollTop = prevScrollTop;
        }
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
        const t = w.target;
        let locLabel = '✨ 编新书';
        if (w.bookTitle) {
            const panPart = t?.panelNumber > 0 ? `·第${t.panelNumber}格` : '';
            const charPart = t?.characterName ? `·${t.characterEmoji || ''}${t.characterName}` : '';
            locLabel = `《${w.bookTitle}》P${w.pageNumber || 1}${panPart}${charPart}`;
        }
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

            const ctx = this.getContext() || {};
            const extraHints = [this.editTarget?.bookTitle, this.editTarget?.characterName, ctx.whisperHints].filter(Boolean);
            const whisperHints = Array.from(new Set(extraHints)).join('，').slice(0, 140);

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
                        uploadBody = JSON.stringify({ audioBase64: wav.base64, hints: whisperHints });
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
                const reqHeaders = { 'Content-Type': uploadCtype };
                if (whisperHints && uploadCtype !== 'application/json') {
                    reqHeaders['X-Story-Hints'] = encodeURIComponent(whisperHints);
                }
                const res = await fetch('/api/mailbox/transcribe', {
                    method: 'POST',
                    headers: reqHeaders,
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
        if (this._sendLock || this.isSending || this.isTranscribing) return;
        this._sendLock = true;
        let wish = null;
        try {
            if (this.isRecording) {
                await this.stopRecording({ transcribeNow: true });
            }

            const text = this.dom.textInput.value.trim();
            if (!text) {
                this.dom.statusHint.textContent = '💡 先按大话筒说话，或者打字写出你想画的故事再发送哦！';
                this.dom.textInput.focus();
                return;
            }

            const t = this.editTarget || {};
            const targetPayload = this._buildWishTargetPayload();
            const pageContext = this._buildPageContextForAi();
            wish = {
                id: `wish_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                kidName: '小豌豆',
                bookId: t.bookId || '',
                bookTitle: t.bookTitle || '',
                pageNumber: t.bookId ? (t.pageNumber || 1) : 1,
                mode: t.bookId ? (t.mode || 'storybook') : 'shelf',
                text,
                target: targetPayload,
                instantReplyKey: '',
                instantReplyText: '',
                status: 'pending',
                syncedCloud: false,
                createdAt: Date.now(),
                createdStr: nowTimeStr()
            };

            this.isSending = true;
            this._dispatchedWishKey = '';
            this._thinkingWishId = wish.id;
            this.state.wishes.push(wish);
            this.dom.textInput.value = '';
            this._saveLocalState();
            this._syncActionButtons();
            this._renderDispatchBar();
            this.renderTimeline({ forceScroll: true });
            this.dom.statusHint.textContent = '🔮 魔法画师正在认真听你的点子…';

            let replyText = '';
            let replyKey = 'local_fallback';
            let audioBase64 = '';

            if (this._shouldUseCloudApi()) {
                const res = await fetch('/api/mailbox/wish', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...wish, pageContext })
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
                        if (data.patrol && typeof data.patrol === 'object') {
                            this._applyPatrolState(data.patrol);
                        }
                    }
                }
            }

            if (!replyText) {
                replyText = t.bookTitle
                    ? `太有想象力啦小豌豆！你说的「${text.slice(0, 26)}」放在《${t.bookTitle}》里一定超级精彩，我已经用魔法画笔记下来啦！`
                    : `哇塞小豌豆！你说的「${text.slice(0, 26)}」真像童话里的魔法，我已经记进魔法画本里啦，马上就去帮你画出来！`;
            }

            wish.instantReplyKey = replyKey;
            wish.instantReplyText = replyText;
            this._thinkingWishId = null;
            this._saveLocalState();
            this.renderTimeline({ forceScroll: true });
            this._renderDispatchBar();
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

            if (wish.syncedCloud) {
                if (this.patrol.enabled) {
                    if (this.dom.wakePrompt) this.dom.wakePrompt.hidden = true;
                    this.dom.statusHint.textContent = '☁️ 已自动唤醒魔法画师！画好后会发语音回信给你哦～';
                } else {
                    if (this.dom.wakePrompt) this.dom.wakePrompt.hidden = false;
                    this.dom.statusHint.textContent = '🌙 已存入云端画本！点上方「✨ 召唤画师立刻来画」就能立刻动笔哦～';
                }
            } else {
                if (this.dom.wakePrompt) this.dom.wakePrompt.hidden = true;
                this.dom.statusHint.textContent = '📮 已记录到本地魔法画本！部署上线后即可同步云端并实时语音陪聊～';
            }
        } catch (_) {
            this._thinkingWishId = null;
            if (wish) {
                wish.instantReplyKey = 'local_fallback';
                wish.instantReplyText = `收到小豌豆的奇思妙想啦！我已经把你的好点子记在魔法画本里了！`;
                this._saveLocalState();
                this.renderTimeline({ forceScroll: true });
            }
        } finally {
            this.isSending = false;
            this._sendLock = false;
            this._syncActionButtons();
        }
    }

    async syncFromCloud({ suppressNewReplyCallback = false } = {}) {
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
            if (data.patrol && typeof data.patrol === 'object') {
                this._applyPatrolState(data.patrol);
            }
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
                this._renderDispatchBar();
                const nextFp = this._getTimelineFingerprint();
                if (nextFp !== this._lastRenderedFingerprint) {
                    this.renderTimeline({ forceScroll: false });
                }
            } else if (!suppressNewReplyCallback && newlyArrived.length > 0) {
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
