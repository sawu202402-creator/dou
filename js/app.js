/**
 * app.js - 《🐰 小豌豆魔法故事漫画屋》前端主控脚本
 * 负责：个人专属书架、精装绘本 / 彩色漫画双模式切换、拼音开关持久化、
 *       多角色语音点击朗读与全书连播、手势/键盘翻页、3 秒轮询后台热刷新。
 */

import { StoryAudioEngine } from './audioEngine.js';
import { HotReloadWatcher } from './hotReload.js';
import { StoryMailboxController } from './storyMailbox.js';
import {
    renderBookshelf,
    renderStorybookPage,
    renderComicPage,
    buildStorySpeakKey,
    buildComicCaptionSpeakKey,
    buildComicBubbleSpeakKey
} from './bookRenderer.js';

const STORAGE_PINYIN_KEY = 'pea_story_house_pinyin';
const STORAGE_PROGRESS_KEY = 'pea_story_house_progress_v1';
const STORAGE_MODE_KEY = 'pea_story_house_mode_v1';
const STORAGE_SPEED_KEY = 'pea_story_house_speed_v1';

const appEl = document.getElementById('app');
const mainStageEl = document.getElementById('main-stage');
const btnBackShelf = document.getElementById('btn-back-shelf');
const headerBookTitle = document.getElementById('header-book-title');
const liveStatusEl = document.getElementById('live-status');
const liveTextEl = liveStatusEl?.querySelector('.live-text');
const modeCapsuleEl = document.getElementById('mode-capsule');
const btnModeStorybook = document.getElementById('btn-mode-storybook');
const btnModeComic = document.getElementById('btn-mode-comic');
const btnTogglePinyin = document.getElementById('btn-toggle-pinyin');
const btnAutoplay = document.getElementById('btn-autoplay');
const autoplayIconEl = document.getElementById('autoplay-icon');
const autoplayLabelEl = document.getElementById('autoplay-label');
const btnSpeed = document.getElementById('btn-speed');
const speedIconEl = document.getElementById('speed-icon');
const speedLabelEl = document.getElementById('speed-label');
const btnToggleMute = document.getElementById('btn-toggle-mute');
const btnRefreshApp = document.getElementById('btn-refresh-app');
const btnOpenMailbox = document.getElementById('btn-open-mailbox');
const mailboxUnreadBadge = document.getElementById('mailbox-unread-badge');
const readerFooterEl = document.getElementById('reader-footer');
const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');
const pageDotsEl = document.getElementById('page-dots');
const pageCounterEl = document.getElementById('page-counter-text');

const artLightboxEl = document.getElementById('art-lightbox');
const artLightboxImgEl = document.getElementById('art-lightbox-img');
const artLightboxCaptionEl = document.getElementById('art-lightbox-caption');
const btnLightboxClose = document.getElementById('btn-lightbox-close');

const hotBannerEl = document.getElementById('hot-reload-banner');
const hotBannerMsgEl = document.getElementById('hot-reload-msg');
const btnBannerReplay = document.getElementById('btn-banner-replay');
const btnBannerGo = document.getElementById('btn-banner-go');
const btnBannerClose = document.getElementById('btn-banner-close');

const state = {
    view: 'shelf',
    mode: 'storybook',
    preferredMode: '',
    pinyinOn: true,
    slowMode: false,
    readingProgress: {},
    manifestBooks: [],
    bookCache: new Map(),
    currentBook: null,
    pageIndex: 0,
    speakingKey: '',
    autoplaying: false,
    autoplayRunId: 0,
    latestVersionInfo: null,
    updatedBookId: '',
    hotReloadCount: 0,
    hotConnected: true,
    bannerMode: 'version',
    bannerReplyText: ''
};

try {
    const savedPinyin = localStorage.getItem(STORAGE_PINYIN_KEY);
    if (savedPinyin === 'off') state.pinyinOn = false;
    const savedSpeed = localStorage.getItem(STORAGE_SPEED_KEY);
    if (savedSpeed === 'slow') state.slowMode = true;
    const savedMode = localStorage.getItem(STORAGE_MODE_KEY);
    if (savedMode === 'storybook' || savedMode === 'comic') state.preferredMode = savedMode;
    const savedProgress = localStorage.getItem(STORAGE_PROGRESS_KEY);
    if (savedProgress) {
        const parsed = JSON.parse(savedProgress);
        if (parsed && typeof parsed === 'object') state.readingProgress = parsed;
    }
} catch (_) {}

function saveCurrentProgress() {
    const book = state.currentBook;
    if (!book || !book.id) return;
    state.readingProgress = {
        ...(state.readingProgress || {}),
        [book.id]: {
            pageIndex: state.pageIndex,
            mode: state.mode,
            updatedAt: Date.now()
        }
    };
    try {
        localStorage.setItem(STORAGE_PROGRESS_KEY, JSON.stringify(state.readingProgress));
    } catch (_) {}
}

function savePreferredMode(mode) {
    if (mode !== 'storybook' && mode !== 'comic') return;
    state.preferredMode = mode;
    try {
        localStorage.setItem(STORAGE_MODE_KEY, mode);
    } catch (_) {}
}

const audioEngine = new StoryAudioEngine({
    playbackRate: state.slowMode ? 0.85 : 1.0,
    onStateChange: (audioState) => {
        if (btnToggleMute) {
            btnToggleMute.textContent = audioState.muted ? '🔇' : '🔊';
            btnToggleMute.setAttribute('aria-pressed', String(audioState.muted));
        }
    }
});

const storyMailbox = new StoryMailboxController({
    audioEngine,
    getContext: () => {
        const charNames = Object.values(state.currentBook?.characters || {})
            .map((c) => c?.name)
            .filter(Boolean);
        const bookTitles = (state.manifestBooks || [])
            .slice(0, 4)
            .map((b) => b?.title)
            .filter(Boolean);
        const whisperHints = Array.from(new Set([...charNames, ...bookTitles])).join('，').slice(0, 140);
        return {
            view: state.view,
            bookId: state.currentBook?.id || '',
            bookTitle: state.currentBook?.title || '',
            pageNumber: (state.pageIndex || 0) + 1,
            mode: state.mode,
            whisperHints
        };
    },
    onBeforeOpen: () => stopAutoplay(),
    onJumpToBook: (bookId, pageNum) => openBook(bookId, pageNum, null, { flashMagic: true }),
    onNewReply: (reply) => {
        state.bannerMode = 'mailbox';
        state.bannerReplyText = reply.text || '';
        if (hotBannerEl && hotBannerMsgEl) {
            hotBannerMsgEl.textContent = `🪄 魔法故事画师给你回信啦：${(reply.text || '').slice(0, 32)}…`;
            hotBannerEl.hidden = false;
        }
    },
    onPatrolChange: () => syncPatrolBadge()
});

function syncPatrolBadge() {
    if (!liveStatusEl || !liveTextEl) return;
    const connected = state.hotConnected;
    liveStatusEl.classList.toggle('is-offline', !connected);
    if (!connected) {
        liveStatusEl.classList.remove('is-patrol-on', 'is-patrol-off', 'is-watcher-offline', 'is-busy');
        liveTextEl.textContent = '重新连线中';
        liveStatusEl.title = '网页连线暂时断开，正在自动重连…';
        return;
    }

    const enabled = Boolean(storyMailbox.patrol?.enabled);
    const watcherOnline = Boolean(storyMailbox.patrol?.watcherOnline);
    const busy = Boolean(storyMailbox._patrolBusy);

    liveStatusEl.setAttribute('aria-pressed', String(enabled));
    liveStatusEl.classList.toggle('is-patrol-on', enabled);
    liveStatusEl.classList.toggle('is-patrol-off', !enabled);
    liveStatusEl.classList.toggle('is-watcher-offline', enabled && !watcherOnline);
    liveStatusEl.classList.toggle('is-busy', busy);
    liveTextEl.textContent = enabled ? '巡检：开' : '巡检：关';

    if (enabled) {
        const remainingMinutes = Number(storyMailbox.patrol?.remainingMinutes) || 0;
        const ttlSuffix = remainingMinutes > 0 ? `，剩余约 ${remainingMinutes} 分钟自动休息` : '';
        liveStatusEl.title = watcherOnline
            ? `画师自动巡检已开启（电脑哨兵在线值守${ttlSuffix}），点击可关闭`
            : `画师自动巡检已开启（等待电脑端哨兵上线${ttlSuffix}），点击可关闭`;
    } else {
        liveStatusEl.title = watcherOnline
            ? '画师自动巡检已关闭（平时零消耗，电脑哨兵待命中），点击开启'
            : '画师自动巡检已关闭（平时零消耗），点击开启';
    }
}

function setSpeakingHighlight(key) {
    state.speakingKey = key || '';
    mainStageEl.querySelectorAll('.is-speaking').forEach((el) => {
        el.classList.remove('is-speaking');
    });
    if (state.speakingKey) {
        mainStageEl.querySelectorAll('[data-speak-key]').forEach((el) => {
            if (el.getAttribute('data-speak-key') === state.speakingKey) {
                el.classList.add('is-speaking');
            }
        });
    }
}

function stopAutoplay() {
    state.autoplayRunId++;
    state.autoplaying = false;
    updateAutoplayButton();
}

function stopAllSpeechAndAutoplay() {
    stopAutoplay();
    audioEngine.stop();
    setSpeakingHighlight('');
}

function updateAutoplayButton() {
    if (!btnAutoplay || !autoplayIconEl || !autoplayLabelEl) return;
    btnAutoplay.classList.toggle('is-playing', state.autoplaying);
    btnAutoplay.setAttribute('aria-pressed', String(state.autoplaying));
    autoplayIconEl.textContent = state.autoplaying ? '⏸️' : '▶️';
    autoplayLabelEl.textContent = state.autoplaying ? '暂停' : '连播';
}

function updateSpeedButton() {
    if (!btnSpeed || !speedIconEl || !speedLabelEl) return;
    btnSpeed.classList.toggle('is-on', state.slowMode);
    btnSpeed.setAttribute('aria-pressed', String(state.slowMode));
    speedIconEl.textContent = state.slowMode ? '🐢' : '🐇';
    speedLabelEl.textContent = state.slowMode ? '慢读' : '常速';
}

function openArtLightbox({ src, caption = '' } = {}) {
    if (!artLightboxEl || !artLightboxImgEl || !src) return;
    artLightboxImgEl.src = src;
    artLightboxImgEl.alt = caption || '故事插画大图';
    if (artLightboxCaptionEl) {
        artLightboxCaptionEl.textContent = caption;
        artLightboxCaptionEl.hidden = !caption;
    }
    artLightboxEl.hidden = false;
}

function closeArtLightbox() {
    if (!artLightboxEl || artLightboxEl.hidden) return;
    artLightboxEl.hidden = true;
    if (artLightboxImgEl) artLightboxImgEl.removeAttribute('src');
}

function syncChrome() {
    appEl.setAttribute('data-view', state.view);
    appEl.setAttribute('data-mode', state.mode);
    appEl.setAttribute('data-pinyin', state.pinyinOn ? 'on' : 'off');

    const inReader = state.view === 'reader' && Boolean(state.currentBook);
    btnBackShelf.hidden = !inReader;
    modeCapsuleEl.hidden = !inReader;
    btnAutoplay.hidden = !inReader;
    if (btnSpeed) btnSpeed.hidden = !inReader;
    readerFooterEl.hidden = !inReader;

    if (inReader) {
        headerBookTitle.hidden = false;
        headerBookTitle.textContent = `${state.currentBook.emoji || ''}《${state.currentBook.title}》`;
    } else {
        headerBookTitle.hidden = true;
        headerBookTitle.textContent = '';
    }

    const isStory = state.mode === 'storybook';
    btnModeStorybook.classList.toggle('is-active', isStory);
    btnModeStorybook.setAttribute('aria-pressed', String(isStory));
    btnModeComic.classList.toggle('is-active', !isStory);
    btnModeComic.setAttribute('aria-pressed', String(!isStory));

    btnTogglePinyin.classList.toggle('is-on', state.pinyinOn);
    btnTogglePinyin.setAttribute('aria-pressed', String(state.pinyinOn));

    updateAutoplayButton();
    updateSpeedButton();
    syncFooterNavigation();
}

function syncFooterNavigation() {
    const pages = state.currentBook?.pages || [];
    const total = pages.length || 1;
    btnPrevPage.disabled = state.pageIndex <= 0;
    btnNextPage.disabled = state.pageIndex >= total - 1;
    pageCounterEl.textContent = `第 ${state.pageIndex + 1} / ${total} 页`;

    pageDotsEl.innerHTML = pages.map((p, idx) => {
        const active = idx === state.pageIndex ? 'is-active' : '';
        return `<button type="button" class="page-dot ${active}" data-page-idx="${idx}" aria-label="跳到第 ${idx + 1} 页"></button>`;
    }).join('');

    pageDotsEl.querySelectorAll('.page-dot').forEach((dot) => {
        dot.addEventListener('click', () => {
            const idx = Number(dot.getAttribute('data-page-idx'));
            goToPage(idx);
        });
    });
}

async function fetchManifest() {
    const res = await fetch(`/books/manifest.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`manifest_http_${res.status}`);
    const data = await res.json();
    state.manifestBooks = Array.isArray(data.books) ? data.books : [];
    return state.manifestBooks;
}

async function fetchBook(bookId, forceRefresh = false) {
    if (!forceRefresh && state.bookCache.has(bookId)) {
        return state.bookCache.get(bookId);
    }
    const res = await fetch(`/books/${encodeURIComponent(bookId)}/book.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`book_http_${res.status}`);
    const book = await res.json();
    state.bookCache.set(bookId, book);
    return book;
}

const preloadedImageUrls = new Set();
const inflightPreloadImages = new Set();
let shelfWarmupTimer = null;
let ttsPrefetchTimer = null;
let ttsPrefetchRunId = 0;

function preloadImages(urls = []) {
    for (const rawUrl of urls) {
        const url = String(rawUrl || '').trim();
        if (!url || preloadedImageUrls.has(url)) continue;
        preloadedImageUrls.add(url);
        const img = new Image();
        img.decoding = 'async';
        inflightPreloadImages.add(img);
        const release = () => inflightPreloadImages.delete(img);
        img.onload = release;
        img.onerror = release;
        img.src = url;
    }
}

function collectPageImageUrls(page, { includeComic = true, includeIllustration = true } = {}) {
    if (!page) return [];
    const urls = [];
    if (includeIllustration && page.illustration) urls.push(page.illustration);
    if (includeComic && Array.isArray(page.panels)) {
        for (const panel of page.panels) {
            if (panel?.image) urls.push(panel.image);
        }
    }
    return urls;
}

function preloadNeighborPages(book, pageIndex) {
    const pages = book?.pages || [];
    if (!pages.length) return;
    const urls = [];
    const cur = pages[pageIndex];
    if (cur) {
        if (state.mode === 'storybook') {
            urls.push(...collectPageImageUrls(cur, { includeComic: true, includeIllustration: false }));
        } else {
            urls.push(...collectPageImageUrls(cur, { includeComic: false, includeIllustration: true }));
        }
    }
    const next = pages[pageIndex + 1];
    if (next) {
        urls.push(...collectPageImageUrls(next, { includeComic: true, includeIllustration: true }));
    }
    const prev = pages[pageIndex - 1];
    if (prev) {
        urls.push(...collectPageImageUrls(prev, { includeComic: false, includeIllustration: true }));
    }
    preloadImages(urls);
}

function warmShelfBooksInBackground() {
    if (shelfWarmupTimer) {
        clearTimeout(shelfWarmupTimer);
        shelfWarmupTimer = null;
    }
    shelfWarmupTimer = setTimeout(async () => {
        if (state.view !== 'shelf') return;
        const targets = (state.manifestBooks || []).slice(0, 3);
        for (let i = 0; i < targets.length; i++) {
            if (state.view !== 'shelf') break;
            const b = await fetchBook(targets[i].id).catch(() => null);
            if (b && i < 2 && b.pages?.[0]?.illustration) {
                preloadImages([b.pages[0].illustration]);
            }
        }
    }, 300);
}

function prefetchCurrentPage() {
    if (ttsPrefetchTimer) {
        clearTimeout(ttsPrefetchTimer);
        ttsPrefetchTimer = null;
    }
    const myRunId = ++ttsPrefetchRunId;
    const book = state.currentBook;
    const page = book?.pages?.[state.pageIndex];
    if (!book || !page || audioEngine.muted) return;

    const queue = [];
    if (state.mode === 'storybook') {
        for (const p of (page.storyParagraphs || []).slice(0, 2)) {
            if (p?.text) queue.push({ text: p.text, role: 'narrator' });
        }
    } else {
        const characters = book.characters || {};
        for (const panel of (page.panels || [])) {
            if (panel.caption && queue.length < 3) {
                queue.push({ text: panel.caption, role: 'narrator' });
            }
            for (const b of (panel.bubbles || [])) {
                if (queue.length >= 3) break;
                const role = characters[b.characterId]?.voiceRole || 'narrator';
                if (b?.text) queue.push({ text: b.text, role });
            }
            if (queue.length >= 3) break;
        }
    }

    if (queue.length === 0) return;

    // 错峰延迟 500ms 再串行预热前几句语音，确保当前页图片优先加载不抢带宽
    ttsPrefetchTimer = setTimeout(async () => {
        for (const item of queue) {
            if (myRunId !== ttsPrefetchRunId || audioEngine.muted) break;
            await audioEngine.prefetch(item.text, item.role);
        }
    }, 500);
}

async function speakSingle(text, role, speakKey) {
    audioEngine.unlockInGesture();
    stopAutoplay();
    setSpeakingHighlight(speakKey);
    await audioEngine.speak(text, role, {
        onEnd: () => {
            if (state.speakingKey === speakKey) {
                setSpeakingHighlight('');
            }
        }
    });
}

function getPageSpeechQueue(book, page) {
    const items = [];
    if (!book || !page) return items;

    if (state.mode === 'storybook') {
        if (page.title) {
            items.push({ text: `第${page.pageNumber}页，${page.title}`, role: 'narrator', speakKey: '' });
        }
        (page.storyParagraphs || []).forEach((p, idx) => {
            items.push({
                text: p.text,
                role: 'narrator',
                speakKey: buildStorySpeakKey(book.id, page.pageNumber, idx)
            });
        });
    } else {
        const characters = book.characters || {};
        (page.panels || []).forEach((panel, pIdx) => {
            if (panel.caption) {
                items.push({
                    text: panel.caption,
                    role: 'narrator',
                    speakKey: buildComicCaptionSpeakKey(book.id, page.pageNumber, pIdx)
                });
            }
            (panel.bubbles || []).forEach((b, bIdx) => {
                const role = characters[b.characterId]?.voiceRole || 'narrator';
                items.push({
                    text: b.text,
                    role,
                    speakKey: buildComicBubbleSpeakKey(book.id, page.pageNumber, pIdx, bIdx)
                });
            });
        });
    }
    return items;
}

async function speakCurrentStorybookPageOnce() {
    audioEngine.unlockInGesture();
    stopAutoplay();
    const book = state.currentBook;
    const page = book?.pages?.[state.pageIndex];
    if (!book || !page) return;

    const myRunId = ++state.autoplayRunId;
    const items = getPageSpeechQueue(book, page);
    for (const item of items) {
        if (state.autoplayRunId !== myRunId || audioEngine.muted) break;
        setSpeakingHighlight(item.speakKey);
        const res = await audioEngine.speak(item.text, item.role);
        if (res.cancelled || state.autoplayRunId !== myRunId) break;
    }
    if (state.autoplayRunId === myRunId) {
        setSpeakingHighlight('');
    }
}

async function startFullBookAutoplay() {
    if (!state.currentBook) return;
    audioEngine.unlockInGesture();
    if (audioEngine.muted) {
        audioEngine.setMuted(false);
    }

    const myRunId = ++state.autoplayRunId;
    state.autoplaying = true;
    updateAutoplayButton();

    while (state.autoplaying && state.autoplayRunId === myRunId && state.currentBook) {
        const book = state.currentBook;
        const page = book.pages?.[state.pageIndex];
        if (!page) break;

        const queue = getPageSpeechQueue(book, page);
        for (let i = 0; i < queue.length; i++) {
            if (!state.autoplaying || state.autoplayRunId !== myRunId) break;
            const item = queue[i];
            const nextItem = queue[i + 1];
            if (nextItem) {
                audioEngine.prefetch(nextItem.text, nextItem.role);
            }
            setSpeakingHighlight(item.speakKey);
            const activeEl = item.speakKey
                ? mainStageEl.querySelector(`[data-speak-key="${CSS.escape(item.speakKey)}"]`)
                : null;
            if (activeEl && typeof activeEl.scrollIntoView === 'function') {
                activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            const res = await audioEngine.speak(item.text, item.role);
            if (res.cancelled || !state.autoplaying || state.autoplayRunId !== myRunId) break;
        }

        if (!state.autoplaying || state.autoplayRunId !== myRunId) break;
        setSpeakingHighlight('');

        const totalPages = book.pages?.length || 1;
        if (state.pageIndex < totalPages - 1) {
            state.pageIndex += 1;
            saveCurrentProgress();
            renderCurrentView();
            await new Promise((r) => setTimeout(r, 260));
        } else {
            break;
        }
    }

    if (state.autoplayRunId === myRunId) {
        state.autoplaying = false;
        setSpeakingHighlight('');
        updateAutoplayButton();
    }
}

function renderCurrentView({ flashMagic = false } = {}) {
    syncChrome();

    if (state.view === 'shelf') {
        renderBookshelf(mainStageEl, state.manifestBooks, {
            latestBookId: state.updatedBookId,
            updatedJustNow: Boolean(state.updatedBookId),
            readingProgress: state.readingProgress,
            onOpenBook: (bookId) => {
                audioEngine.unlockInGesture();
                openBook(bookId, null, null, { resumeProgress: true });
            },
            onHoverBook: (bookId) => {
                fetchBook(bookId).then((b) => {
                    const p = b?.pages?.[0];
                    if (p?.illustration) preloadImages([p.illustration]);
                }).catch(() => {});
            },
            onOpenMailbox: () => {
                audioEngine.unlockInGesture();
                storyMailbox.open();
            }
        });
        warmShelfBooksInBackground();
        return;
    }

    const book = state.currentBook;
    const pages = book?.pages || [];
    if (!book || pages.length === 0) {
        mainStageEl.innerHTML = `<div class="loading-box">这本书还没有画好呢，回去看看书架吧～</div>`;
        return;
    }

    if (state.pageIndex < 0) state.pageIndex = 0;
    if (state.pageIndex >= pages.length) state.pageIndex = pages.length - 1;
    const page = pages[state.pageIndex];

    if (state.mode === 'storybook') {
        renderStorybookPage(mainStageEl, book, page, {
            pageIndex: state.pageIndex,
            totalPages: pages.length,
            speakingKey: state.speakingKey,
            onSpeakParagraph: (para, _idx, key) => speakSingle(para.text, 'narrator', key),
            onSpeakPage: () => speakCurrentStorybookPageOnce()
        });
    } else {
        renderComicPage(mainStageEl, book, page, {
            pageIndex: state.pageIndex,
            totalPages: pages.length,
            speakingKey: state.speakingKey,
            onSpeakItem: ({ text, role, speakKey }) => speakSingle(text, role, speakKey),
            onZoomImage: (info) => openArtLightbox(info)
        });
    }

    if (flashMagic) {
        const panel = mainStageEl.firstElementChild;
        if (panel) panel.classList.add('page-magic-flash');
    }

    preloadNeighborPages(book, state.pageIndex);
    prefetchCurrentPage();
}

async function openBook(bookId, pageNum = 1, modeOverride = null, { flashMagic = false, resumeProgress = false } = {}) {
    stopAllSpeechAndAutoplay();
    try {
        const book = await fetchBook(bookId);
        state.currentBook = book;
        state.view = 'reader';

        const totalPages = Math.max(1, book.pages?.length || 1);
        const prog = state.readingProgress?.[bookId];
        let targetPageNum = Number(pageNum) || 1;
        if (resumeProgress && pageNum === null) {
            if (prog && Number.isFinite(Number(prog.pageIndex)) && prog.pageIndex > 0 && prog.pageIndex < totalPages - 1) {
                targetPageNum = prog.pageIndex + 1;
            } else {
                targetPageNum = 1;
            }
        }
        state.pageIndex = Math.max(0, Math.min(totalPages - 1, targetPageNum - 1));

        if (modeOverride) {
            state.mode = modeOverride;
        } else {
            const manifestItem = state.manifestBooks.find((b) => b.id === bookId);
            state.mode = (resumeProgress ? prog?.mode : '') || state.preferredMode || manifestItem?.defaultMode || 'storybook';
        }

        saveCurrentProgress();
        renderCurrentView({ flashMagic });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
        mainStageEl.innerHTML = `<div class="loading-box">哎呀，打开故事书失败了：${err.message}</div>`;
    }
}

function goToShelf() {
    stopAllSpeechAndAutoplay();
    state.view = 'shelf';
    state.currentBook = null;
    renderCurrentView();
}

function goToPage(nextIndex) {
    if (!state.currentBook) return;
    const total = state.currentBook.pages?.length || 1;
    if (nextIndex < 0 || nextIndex >= total || nextIndex === state.pageIndex) return;
    stopAllSpeechAndAutoplay();
    state.pageIndex = nextIndex;
    saveCurrentProgress();
    renderCurrentView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showHotReloadBanner(versionData) {
    if (!hotBannerEl || !hotBannerMsgEl) return;
    hotBannerMsgEl.textContent = versionData.announcement || versionData.summary || '有新故事上线啦！';
    hotBannerEl.hidden = false;
}

function bindEvents() {
    btnBackShelf.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        goToShelf();
    });

    btnModeStorybook.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        if (state.mode !== 'storybook') {
            stopAllSpeechAndAutoplay();
            state.mode = 'storybook';
            savePreferredMode('storybook');
            saveCurrentProgress();
            renderCurrentView();
        }
    });

    btnModeComic.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        if (state.mode !== 'comic') {
            stopAllSpeechAndAutoplay();
            state.mode = 'comic';
            savePreferredMode('comic');
            saveCurrentProgress();
            renderCurrentView();
        }
    });

    btnTogglePinyin.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        state.pinyinOn = !state.pinyinOn;
        try {
            localStorage.setItem(STORAGE_PINYIN_KEY, state.pinyinOn ? 'on' : 'off');
        } catch (_) {}
        syncChrome();
    });

    btnAutoplay.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        if (state.autoplaying) {
            stopAllSpeechAndAutoplay();
        } else {
            startFullBookAutoplay();
        }
    });

    btnSpeed?.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        state.slowMode = !state.slowMode;
        audioEngine.setPlaybackRate(state.slowMode ? 0.85 : 1.0);
        try {
            localStorage.setItem(STORAGE_SPEED_KEY, state.slowMode ? 'slow' : 'normal');
        } catch (_) {}
        syncChrome();
    });

    btnToggleMute.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        const nextMuted = !audioEngine.muted;
        if (nextMuted) stopAutoplay();
        audioEngine.setMuted(nextMuted);
    });

    btnRefreshApp?.addEventListener('click', () => {
        stopAllSpeechAndAutoplay();
        window.location.reload();
    });

    btnLightboxClose?.addEventListener('click', () => closeArtLightbox());
    artLightboxEl?.addEventListener('click', (e) => {
        if (e.target === artLightboxEl) closeArtLightbox();
    });

    btnOpenMailbox?.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        storyMailbox.open();
    });

    liveStatusEl?.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        storyMailbox.togglePatrol();
    });

    btnPrevPage.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        goToPage(state.pageIndex - 1);
    });

    btnNextPage.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        goToPage(state.pageIndex + 1);
    });

    btnBannerGo.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        hotBannerEl.hidden = true;
        if (state.bannerMode === 'mailbox') {
            storyMailbox.open();
            return;
        }
        const info = state.latestVersionInfo;
        if (info?.latestBookId) {
            openBook(info.latestBookId, info.latestPage || 1, null, { flashMagic: true });
        }
    });

    btnBannerReplay.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        const msg = state.bannerMode === 'mailbox'
            ? state.bannerReplyText
            : (state.latestVersionInfo?.announcement || hotBannerMsgEl.textContent);
        if (msg) {
            audioEngine.speak(msg, state.bannerMode === 'mailbox' ? 'narrator' : 'system_notice');
        }
    });

    btnBannerClose.addEventListener('click', () => {
        hotBannerEl.hidden = true;
    });

    // iPad 触屏左右滑动翻页
    let touchStartX = 0;
    let touchStartY = 0;
    mainStageEl.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        }
    }, { passive: true });

    mainStageEl.addEventListener('touchend', (e) => {
        if (state.view !== 'reader' || e.changedTouches.length !== 1) return;
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.4) {
            if (dx < 0) goToPage(state.pageIndex + 1);
            else goToPage(state.pageIndex - 1);
        }
    }, { passive: true });

    // 键盘左右键翻页 & Esc 关闭插画大图
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && artLightboxEl && !artLightboxEl.hidden) {
            closeArtLightbox();
            return;
        }
        if (state.view !== 'reader') return;
        if (e.key === 'ArrowLeft') goToPage(state.pageIndex - 1);
        else if (e.key === 'ArrowRight') goToPage(state.pageIndex + 1);
    });
}

const hotWatcher = new HotReloadWatcher({
    intervalMs: 3000,
    onStatusChange: ({ connected }) => {
        state.hotConnected = connected;
        syncPatrolBadge();
    },
    onInit: (data) => {
        state.latestVersionInfo = data;
    },
    onUpdate: async (data) => {
        state.hotReloadCount += 1;
        state.latestVersionInfo = data;
        state.updatedBookId = data.latestBookId || '';
        audioEngine.clearCache();

        await fetchManifest().catch(() => {});

        if (data.latestBookId) {
            state.bookCache.delete(data.latestBookId);
        }

        if (state.view === 'reader' && state.currentBook) {
            const refreshed = await fetchBook(state.currentBook.id, true).catch(() => null);
            if (refreshed) {
                state.currentBook = refreshed;
                if (
                    data.latestBookId === refreshed.id &&
                    (data.changeType === 'new_page' || data.changeType === 'updated_page' || data.changeType === 'updated_book')
                ) {
                    const targetIdx = Math.max(0, Math.min((refreshed.pages?.length || 1) - 1, (Number(data.latestPage) || 1) - 1));
                    state.pageIndex = targetIdx;
                    saveCurrentProgress();
                }
            }
            renderCurrentView({ flashMagic: true });
        } else {
            renderCurrentView();
        }

        state.bannerMode = 'version';
        showHotReloadBanner(data);
        storyMailbox.syncFromCloud().catch(() => {});
        if (data.announcement && !audioEngine.muted) {
            audioEngine.speak(data.announcement, 'system_notice').catch(() => {});
        }
    }
});

async function bootstrap() {
    bindEvents();
    syncPatrolBadge();
    storyMailbox.bindBadgeEl(mailboxUnreadBadge);
    storyMailbox.init();
    try {
        await fetchManifest();
        const params = new URLSearchParams(window.location.search);
        const bookId = params.get('book');
        const pageParam = Number(params.get('page') || 1);
        const modeParam = params.get('mode');
        if (bookId) {
            await openBook(bookId, pageParam, modeParam);
        } else {
            renderCurrentView();
        }
    } catch (err) {
        mainStageEl.innerHTML = `<div class="loading-box">书架加载中遇到了一点小魔法风波：${err.message}</div>`;
    }

    hotWatcher.start();
}

window.__PEA_STORY_HOUSE__ = {
    getState: () => ({
        view: state.view,
        mode: state.mode,
        pinyinOn: state.pinyinOn,
        currentBookId: state.currentBook?.id || null,
        pageIndex: state.pageIndex,
        autoplaying: state.autoplaying,
        hotReloadCount: state.hotReloadCount,
        version: hotWatcher.currentVersion,
        isSpeaking: audioEngine.isSpeaking,
        patrolEnabled: Boolean(storyMailbox.patrol?.enabled),
        slowMode: state.slowMode,
        readingProgress: state.readingProgress
    }),
    checkVersionNow: () => hotWatcher.checkNow(),
    audioEngine,
    mailbox: storyMailbox
};

bootstrap();
