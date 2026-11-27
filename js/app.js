/**
 * app.js - 《🐰 小豌豆魔法故事漫画屋》前端主控脚本
 * 负责：个人专属书架、精装绘本 / 彩色漫画双模式切换、拼音开关持久化、
 *       多角色语音点击朗读与全书连播、手势/键盘翻页、3 秒轮询后台热刷新。
 */

import { StoryAudioEngine } from './audioEngine.js';
import { HotReloadWatcher } from './hotReload.js';
import {
    renderBookshelf,
    renderStorybookPage,
    renderComicPage,
    buildStorySpeakKey,
    buildComicCaptionSpeakKey,
    buildComicBubbleSpeakKey
} from './bookRenderer.js';

const STORAGE_PINYIN_KEY = 'pea_story_house_pinyin';

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
const btnToggleMute = document.getElementById('btn-toggle-mute');
const readerFooterEl = document.getElementById('reader-footer');
const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');
const pageDotsEl = document.getElementById('page-dots');
const pageCounterEl = document.getElementById('page-counter-text');

const hotBannerEl = document.getElementById('hot-reload-banner');
const hotBannerMsgEl = document.getElementById('hot-reload-msg');
const btnBannerReplay = document.getElementById('btn-banner-replay');
const btnBannerGo = document.getElementById('btn-banner-go');
const btnBannerClose = document.getElementById('btn-banner-close');

const state = {
    view: 'shelf',
    mode: 'storybook',
    pinyinOn: true,
    manifestBooks: [],
    bookCache: new Map(),
    currentBook: null,
    pageIndex: 0,
    speakingKey: '',
    autoplaying: false,
    autoplayRunId: 0,
    latestVersionInfo: null,
    updatedBookId: '',
    hotReloadCount: 0
};

try {
    const savedPinyin = localStorage.getItem(STORAGE_PINYIN_KEY);
    if (savedPinyin === 'off') state.pinyinOn = false;
} catch (_) {}

const audioEngine = new StoryAudioEngine({
    onStateChange: (audioState) => {
        if (btnToggleMute) {
            btnToggleMute.textContent = audioState.muted ? '🔇' : '🔊';
            btnToggleMute.setAttribute('aria-pressed', String(audioState.muted));
        }
    }
});

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

function syncChrome() {
    appEl.setAttribute('data-view', state.view);
    appEl.setAttribute('data-mode', state.mode);
    appEl.setAttribute('data-pinyin', state.pinyinOn ? 'on' : 'off');

    const inReader = state.view === 'reader' && Boolean(state.currentBook);
    btnBackShelf.hidden = !inReader;
    modeCapsuleEl.hidden = !inReader;
    btnAutoplay.hidden = !inReader;
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

function prefetchCurrentPage() {
    const book = state.currentBook;
    const page = book?.pages?.[state.pageIndex];
    if (!book || !page || audioEngine.muted) return;

    if (state.mode === 'storybook') {
        const paras = page.storyParagraphs || [];
        if (paras[0]) audioEngine.prefetch(paras[0].text, 'narrator');
        if (paras[1]) audioEngine.prefetch(paras[1].text, 'narrator');
    } else {
        const characters = book.characters || {};
        (page.panels || []).forEach((panel) => {
            if (panel.caption) audioEngine.prefetch(panel.caption, 'narrator');
            (panel.bubbles || []).forEach((b) => {
                const role = characters[b.characterId]?.voiceRole || 'narrator';
                audioEngine.prefetch(b.text, role);
            });
        });
    }
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
            onOpenBook: (bookId) => {
                audioEngine.unlockInGesture();
                openBook(bookId, 1);
            }
        });
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
            onSpeakItem: ({ text, role, speakKey }) => speakSingle(text, role, speakKey)
        });
    }

    if (flashMagic) {
        const panel = mainStageEl.firstElementChild;
        if (panel) panel.classList.add('page-magic-flash');
    }

    prefetchCurrentPage();
}

async function openBook(bookId, pageNum = 1, modeOverride = null, { flashMagic = false } = {}) {
    stopAllSpeechAndAutoplay();
    try {
        const book = await fetchBook(bookId);
        state.currentBook = book;
        state.view = 'reader';
        state.pageIndex = Math.max(0, Math.min((book.pages?.length || 1) - 1, (Number(pageNum) || 1) - 1));
        if (modeOverride) {
            state.mode = modeOverride;
        } else {
            const manifestItem = state.manifestBooks.find((b) => b.id === bookId);
            state.mode = manifestItem?.defaultMode || 'storybook';
        }
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
            renderCurrentView();
        }
    });

    btnModeComic.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        if (state.mode !== 'comic') {
            stopAllSpeechAndAutoplay();
            state.mode = 'comic';
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

    btnToggleMute.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        const nextMuted = !audioEngine.muted;
        if (nextMuted) stopAutoplay();
        audioEngine.setMuted(nextMuted);
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
        const info = state.latestVersionInfo;
        hotBannerEl.hidden = true;
        if (info?.latestBookId) {
            openBook(info.latestBookId, info.latestPage || 1, null, { flashMagic: true });
        }
    });

    btnBannerReplay.addEventListener('click', () => {
        audioEngine.unlockInGesture();
        const msg = state.latestVersionInfo?.announcement || hotBannerMsgEl.textContent;
        if (msg) {
            audioEngine.speak(msg, 'system_notice');
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

    // 键盘左右键翻页
    window.addEventListener('keydown', (e) => {
        if (state.view !== 'reader') return;
        if (e.key === 'ArrowLeft') goToPage(state.pageIndex - 1);
        else if (e.key === 'ArrowRight') goToPage(state.pageIndex + 1);
    });
}

const hotWatcher = new HotReloadWatcher({
    intervalMs: 3000,
    onStatusChange: ({ connected }) => {
        if (!liveStatusEl || !liveTextEl) return;
        liveStatusEl.classList.toggle('is-offline', !connected);
        liveTextEl.textContent = connected ? '魔法连线中' : '重新连线中';
    },
    onInit: (data) => {
        state.latestVersionInfo = data;
    },
    onUpdate: async (data) => {
        state.hotReloadCount += 1;
        state.latestVersionInfo = data;
        state.updatedBookId = data.latestBookId || '';

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
                }
            }
            renderCurrentView({ flashMagic: true });
        } else {
            renderCurrentView();
        }

        showHotReloadBanner(data);
        if (data.announcement && !audioEngine.muted) {
            audioEngine.speak(data.announcement, 'system_notice').catch(() => {});
        }
    }
});

async function bootstrap() {
    bindEvents();
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
        isSpeaking: audioEngine.isSpeaking
    }),
    checkVersionNow: () => hotWatcher.checkNow(),
    audioEngine
};

bootstrap();
