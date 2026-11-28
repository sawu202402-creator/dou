/**
 * bookRenderer.js - 书架、精装有声绘本模式、彩色多格漫画模式视图渲染器
 */

import { escapeHtml, renderPinyinHtml } from './pinyinRenderer.js';

export function buildStorySpeakKey(bookId, pageNumber, paraIdx) {
    return `story:${bookId}:p${pageNumber}:para${paraIdx}`;
}

export function buildComicCaptionSpeakKey(bookId, pageNumber, panelIdx) {
    return `comic:${bookId}:p${pageNumber}:panel${panelIdx}:cap`;
}

export function buildComicBubbleSpeakKey(bookId, pageNumber, panelIdx, bubbleIdx) {
    return `comic:${bookId}:p${pageNumber}:panel${panelIdx}:b${bubbleIdx}`;
}

export function buildNotebookWordSpeakKey(bookId, pageNumber, wordIdx) {
    return `nbword:${bookId}:p${pageNumber}:w${wordIdx}`;
}

export function buildNotebookSentenceSpeakKey(bookId, pageNumber, sentIdx) {
    return `nbsent:${bookId}:p${pageNumber}:s${sentIdx}`;
}

/**
 * 渲染个人专属书架
 */
export function renderBookshelf(container, books, {
    latestBookId = '',
    updatedJustNow = false,
    readingProgress = {},
    voiceProfile = null,
    voiceSummary = null,
    onOpenBook,
    onHoverBook,
    onOpenMailbox,
    onOpenVoiceStudio
} = {}) {
    if (!container) return;

    const cardsHtml = (books || []).map((book) => {
        const isFresh = updatedJustNow && book.id === latestBookId;
        const tagsHtml = (book.tags || []).slice(0, 3).map(t => `<span class="shelf-tag">${escapeHtml(t)}</span>`).join('');
        const pageCount = Math.max(1, Number(book.pageCount) || 1);
        const prog = readingProgress?.[book.id];
        let progressHtml = '';
        if (prog && Number.isFinite(Number(prog.pageIndex))) {
            const pNum = Math.max(1, Math.min(pageCount, Number(prog.pageIndex) + 1));
            if (pNum >= pageCount) {
                progressHtml = `<span class="progress-pill is-done">🌟 已读完</span>`;
            } else if (pNum > 1) {
                progressHtml = `<span class="progress-pill">🔖 读到第 ${pNum} 页</span>`;
            }
        }
        return `
            <article class="book-card ${isFresh ? 'is-fresh' : ''}" data-book-id="${escapeHtml(book.id)}" tabindex="0" role="button" aria-label="打开《${escapeHtml(book.title)}》">
                ${isFresh ? '<div class="fresh-ribbon">✨ 刚刚上新</div>' : ''}
                <div class="book-cover-wrap">
                    <img src="${escapeHtml(book.cover)}" alt="${escapeHtml(book.title)}" class="book-cover-img" loading="eager" decoding="async" fetchpriority="high">
                    <div class="book-spine-shine"></div>
                </div>
                <div class="book-card-body">
                    <h2 class="book-card-title">${escapeHtml(book.emoji || '📖')} ${escapeHtml(book.title)}</h2>
                    <p class="book-card-sub">${escapeHtml(book.subtitle || '')}</p>
                    <div class="book-card-meta">
                        <span class="page-pill">📖 ${pageCount} 页</span>
                        ${progressHtml || (book.bookType === 'notebook'
                            ? '<span class="mode-pill is-notebook">📝 好词佳句本</span>'
                            : '<span class="mode-pill">绘本 · 漫画</span>')}
                    </div>
                    ${tagsHtml ? `<div class="book-card-tags">${tagsHtml}</div>` : ''}
                </div>
            </article>
        `;
    }).join('');

    const magicHintCard = `
        <button type="button" id="btn-shelf-open-mailbox" class="book-magic-card" aria-label="点这里跟魔法画师说话创作新故事">
            <div class="magic-card-icon">🪄🐰🎙️</div>
            <h3>想要更多新故事吗？</h3>
            <p>点这里直接用语音或打字告诉魔法画师你的新点子，画好就会飞到书架上哦！</p>
            <span class="magic-card-cta">🎙️ 跟魔法画师聊故事</span>
        </button>
    `;

    const vp = voiceProfile || {};
    const activeCount = Number(voiceSummary?.activeCount) || (vp.cloneReady ? 1 : 0);
    const sampleCount = Number(voiceSummary?.sampleCount) || ((vp.hasSample || vp.overrideVoiceConfigured) ? 1 : 0);
    let voicePillLabel = '🎙️ 录小豌豆和朋友声音';
    if (activeCount > 1) {
        voicePillLabel = `🎙️ ${activeCount} 个专属声音生效中`;
    } else if (activeCount === 1) {
        voicePillLabel = '🎙️ 专属声音生效中';
    } else if (sampleCount > 0) {
        voicePillLabel = '🎙️ 原声已存(待Key)';
    }
    const voicePillReadyCls = activeCount > 0 ? ' is-ready' : '';

    container.innerHTML = `
        <section class="shelf-hero">
            <div class="shelf-hero-text">
                <h1>🐰 小豌豆的魔法书架</h1>
                <p>点开一本书，可以切换「精装绘本」或「多格漫画」两种阅读魔法哦！</p>
            </div>
            <div class="shelf-hero-badges">
                <button type="button" id="btn-shelf-voice-studio" class="btn-shelf-voice${voicePillReadyCls}">${voicePillLabel}</button>
                <div class="shelf-count-badge">📚 共 ${books.length} 本原创作品</div>
            </div>
        </section>
        <div class="bookshelf-grid">
            ${cardsHtml}
            ${magicHintCard}
        </div>
    `;

    container.querySelectorAll('.book-card').forEach((card) => {
        const bookId = card.getAttribute('data-book-id');
        const open = () => {
            if (bookId && typeof onOpenBook === 'function') {
                onOpenBook(bookId);
            }
        };
        const warm = () => {
            if (bookId && typeof onHoverBook === 'function') {
                onHoverBook(bookId);
            }
        };
        card.addEventListener('click', open);
        card.addEventListener('pointerenter', warm, { once: true });
        card.addEventListener('touchstart', warm, { passive: true, once: true });
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
            }
        });
    });

    const shelfMailboxBtn = container.querySelector('#btn-shelf-open-mailbox');
    if (shelfMailboxBtn && typeof onOpenMailbox === 'function') {
        shelfMailboxBtn.addEventListener('click', () => onOpenMailbox());
    }

    const shelfVoiceBtn = container.querySelector('#btn-shelf-voice-studio');
    if (shelfVoiceBtn && typeof onOpenVoiceStudio === 'function') {
        shelfVoiceBtn.addEventListener('click', () => onOpenVoiceStudio());
    }
}

/**
 * 模式 ①：精装有声绘本模式（左图右文翻页 + 二年级拼音开关 + 逐段/整页朗读）
 */
export function renderStorybookPage(container, book, page, {
    pageIndex = 0,
    totalPages = 1,
    speakingKey = '',
    onSpeakParagraph,
    onSpeakPage,
    onEditPage
} = {}) {
    if (!container || !book || !page) return;

    const paragraphs = page.storyParagraphs || [];
    const paraHtml = paragraphs.map((p, idx) => {
        const key = buildStorySpeakKey(book.id, page.pageNumber, idx);
        const active = speakingKey === key ? 'is-speaking' : '';
        return `
            <button type="button" class="story-para-btn ${active}" data-para-idx="${idx}" data-speak-key="${escapeHtml(key)}">
                <span class="story-para-text">${renderPinyinHtml(p.text, p.pinyin)}</span>
                <span class="para-speak-badge" aria-hidden="true">🔊</span>
            </button>
        `;
    }).join('');

    container.innerHTML = `
        <article class="storybook-spread" data-page-number="${page.pageNumber}">
            <div class="storybook-left-page">
                <button type="button" class="storybook-art-btn" id="btn-storybook-art" aria-label="点击插画听本页故事">
                    <span class="storybook-page-ribbon">第 ${pageIndex + 1} / ${totalPages} 页</span>
                    <img src="${escapeHtml(page.illustration)}" alt="${escapeHtml(page.title)}" class="storybook-illustration" loading="eager" decoding="async" fetchpriority="high">
                    <span class="art-tap-hint">🔊 点图画听本页</span>
                </button>
            </div>
            <div class="storybook-spine" aria-hidden="true"></div>
            <div class="storybook-right-page">
                <header class="storybook-chapter-head">
                    <span class="chapter-badge">${escapeHtml(book.emoji || '🐰')} 第 ${page.pageNumber} 页</span>
                    <h2 class="storybook-title">${renderPinyinHtml(page.title, page.titlePinyin)}</h2>
                </header>
                <div class="storybook-paragraphs">
                    ${paraHtml}
                </div>
                <footer class="storybook-actions">
                    <button type="button" class="btn-read-page" id="btn-read-storybook-page">
                        🔊 朗读这一页
                    </button>
                    <button type="button" class="btn-edit-page" id="btn-edit-storybook-page">
                        ✏️ 改这一页
                    </button>
                    <span class="storybook-tip">点任意一段文字也可以单独朗读哦</span>
                </footer>
            </div>
        </article>
    `;

    const artBtn = container.querySelector('#btn-storybook-art');
    const pageBtn = container.querySelector('#btn-read-storybook-page');
    const editBtn = container.querySelector('#btn-edit-storybook-page');
    if (artBtn && typeof onSpeakPage === 'function') {
        artBtn.addEventListener('click', () => onSpeakPage());
    }
    if (pageBtn && typeof onSpeakPage === 'function') {
        pageBtn.addEventListener('click', () => onSpeakPage());
    }
    if (editBtn && typeof onEditPage === 'function') {
        editBtn.addEventListener('click', () => onEditPage({
            scope: 'page',
            bookId: book.id,
            bookTitle: book.title,
            pageNumber: page.pageNumber,
            mode: 'storybook'
        }));
    }

    container.querySelectorAll('.story-para-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const idx = Number(btn.getAttribute('data-para-idx'));
            const para = paragraphs[idx];
            if (para && typeof onSpeakParagraph === 'function') {
                onSpeakParagraph(para, idx, btn.getAttribute('data-speak-key'));
            }
        });
    });
}

/**
 * 模式 ③：文字主导《好文章好词好句积累本》模式（适合散文、童话、日积月累与长期扩充）
 */
export function renderNotebookPage(container, book, page, {
    pageIndex = 0,
    totalPages = 1,
    speakingKey = '',
    onSpeakParagraph,
    onSpeakPage,
    onSpeakCustom,
    onEditPage,
    onZoomImage
} = {}) {
    if (!container || !book || !page) return;

    const paragraphs = page.storyParagraphs || [];
    const goodWords = Array.isArray(page.goodWords) ? page.goodWords : [];
    const goodSentences = Array.isArray(page.goodSentences) ? page.goodSentences : [];

    const paraHtml = paragraphs.map((p, idx) => {
        const key = buildStorySpeakKey(book.id, page.pageNumber, idx);
        const active = speakingKey === key ? 'is-speaking' : '';
        return `
            <button type="button" class="story-para-btn ${active}" data-para-idx="${idx}" data-speak-key="${escapeHtml(key)}">
                <span class="story-para-text">${renderPinyinHtml(p.text, p.pinyin)}</span>
                <span class="para-speak-badge" aria-hidden="true">🔊</span>
            </button>
        `;
    }).join('');

    const wordsHtml = goodWords.length > 0
        ? `
            <section class="notebook-words-box" aria-label="好词宝石盒">
                <div class="notebook-subhead">✨ 好词宝石盒 <span class="notebook-subtip">点一点听读音和意思</span></div>
                <div class="word-gem-grid">
                    ${goodWords.map((w, idx) => {
                        const key = buildNotebookWordSpeakKey(book.id, page.pageNumber, idx);
                        const active = speakingKey === key ? 'is-speaking' : '';
                        return `
                            <button type="button" class="word-gem-card ${active}" data-word-idx="${idx}" data-speak-key="${escapeHtml(key)}">
                                <span class="word-gem-top">
                                    <span class="word-gem-term">${renderPinyinHtml(w.word, w.pinyin)}</span>
                                    <span aria-hidden="true">🔊</span>
                                </span>
                                <span class="word-gem-meaning">${escapeHtml(w.meaning || '')}</span>
                            </button>
                        `;
                    }).join('')}
                </div>
            </section>
        `
        : '';

    const sentencesHtml = goodSentences.length > 0
        ? `
            <section class="notebook-sentences-box" aria-label="佳句摘抄栏">
                <div class="notebook-subhead">💛 佳句摘抄栏 <span class="notebook-subtip">写作文可以直接学着这样写！</span></div>
                <div class="sentence-quote-list">
                    ${goodSentences.map((s, idx) => {
                        const key = buildNotebookSentenceSpeakKey(book.id, page.pageNumber, idx);
                        const active = speakingKey === key ? 'is-speaking' : '';
                        return `
                            <button type="button" class="sentence-quote-card ${active}" data-sent-idx="${idx}" data-speak-key="${escapeHtml(key)}">
                                <div class="sentence-quote-main">
                                    <span class="sentence-quote-text">${renderPinyinHtml(s.text, s.pinyin)}</span>
                                    <span class="para-speak-badge" aria-hidden="true">🔊</span>
                                </div>
                                ${s.note ? `<span class="sentence-quote-note">💡 ${escapeHtml(s.note)}</span>` : ''}
                            </button>
                        `;
                    }).join('')}
                </div>
            </section>
        `
        : '';

    const tipHtml = page.readingTip
        ? `<div class="notebook-tip-box">📝 <strong>小豌豆写作小秘诀：</strong>${escapeHtml(page.readingTip)}</div>`
        : '';

    const thumbHtml = page.illustration
        ? `
            <button type="button" class="notebook-thumb-btn" data-zoom-src="${escapeHtml(page.illustration)}" data-zoom-caption="${escapeHtml(page.title)}" aria-label="点击放大查看本篇配图">
                <img src="${escapeHtml(page.illustration)}" alt="${escapeHtml(page.title)}" class="notebook-thumb-img" loading="eager" decoding="async">
                <span class="notebook-thumb-tag">🔍 看配图</span>
            </button>
        `
        : '';

    container.innerHTML = `
        <article class="notebook-sheet" data-page-number="${page.pageNumber}">
            <header class="notebook-header">
                <div class="notebook-header-main">
                    <div class="notebook-pills-row">
                        <span class="chapter-badge">${escapeHtml(book.emoji || '📖')} 第 ${pageIndex + 1} / ${totalPages} 篇</span>
                        ${page.genre ? `<span class="notebook-genre-pill">${escapeHtml(page.genre)}</span>` : ''}
                        ${page.articleAuthor ? `<span class="notebook-author-pill">✍️ 作者：${escapeHtml(page.articleAuthor)}</span>` : ''}
                    </div>
                    <h2 class="notebook-title">${renderPinyinHtml(page.title, page.titlePinyin)}</h2>
                    <div class="notebook-header-actions">
                        <button type="button" class="btn-read-page" id="btn-read-storybook-page">🔊 朗读这一篇</button>
                        <button type="button" class="btn-edit-page" id="btn-edit-storybook-page">✏️ 改这一页 / 添新篇</button>
                    </div>
                </div>
                ${thumbHtml}
            </header>

            <div class="storybook-paragraphs notebook-paragraphs">
                ${paraHtml}
            </div>
            ${wordsHtml}
            ${sentencesHtml}
            ${tipHtml}
        </article>
    `;

    const pageBtn = container.querySelector('#btn-read-storybook-page');
    const editBtn = container.querySelector('#btn-edit-storybook-page');
    const thumbBtn = container.querySelector('.notebook-thumb-btn');
    if (pageBtn && typeof onSpeakPage === 'function') {
        pageBtn.addEventListener('click', () => onSpeakPage());
    }
    if (editBtn && typeof onEditPage === 'function') {
        editBtn.addEventListener('click', () => onEditPage({
            scope: 'page',
            bookId: book.id,
            bookTitle: book.title,
            pageNumber: page.pageNumber,
            mode: 'storybook'
        }));
    }
    if (thumbBtn && typeof onZoomImage === 'function') {
        thumbBtn.addEventListener('click', () => onZoomImage({
            src: thumbBtn.getAttribute('data-zoom-src') || '',
            caption: thumbBtn.getAttribute('data-zoom-caption') || ''
        }));
    }

    container.querySelectorAll('.story-para-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const idx = Number(btn.getAttribute('data-para-idx'));
            const para = paragraphs[idx];
            if (para && typeof onSpeakParagraph === 'function') {
                onSpeakParagraph(para, idx, btn.getAttribute('data-speak-key'));
            }
        });
    });

    container.querySelectorAll('.word-gem-card').forEach((btn) => {
        btn.addEventListener('click', () => {
            const idx = Number(btn.getAttribute('data-word-idx'));
            const gw = goodWords[idx];
            if (gw && typeof onSpeakCustom === 'function') {
                onSpeakCustom({
                    text: `好词：${gw.word}。${gw.meaning || ''}`,
                    role: 'narrator',
                    speakKey: btn.getAttribute('data-speak-key')
                });
            }
        });
    });

    container.querySelectorAll('.sentence-quote-card').forEach((btn) => {
        btn.addEventListener('click', () => {
            const idx = Number(btn.getAttribute('data-sent-idx'));
            const gs = goodSentences[idx];
            if (gs && typeof onSpeakCustom === 'function') {
                onSpeakCustom({
                    text: gs.note ? `${gs.text}。${gs.note}` : gs.text,
                    role: 'narrator',
                    speakKey: btn.getAttribute('data-speak-key')
                });
            }
        });
    });
}

/**
 * 模式 ②：彩色多格漫画模式（分镜框 + 拟声词贴纸 + 点击角色对话气泡对应声线朗读）
 */
export function renderComicPage(container, book, page, {
    pageIndex = 0,
    totalPages = 1,
    speakingKey = '',
    isCharacterCloned = () => false,
    onSpeakItem,
    onZoomImage,
    onEditTarget,
    onOpenVoiceForCharacter
} = {}) {
    if (!container || !book || !page) return;

    const characters = book.characters || {};
    const panels = page.panels || [];
    const layout = page.comicLayout || 'hero-top';

    // 收集本页出场角色作为可点击录音图例
    const appearingCharIds = new Set();
    panels.forEach((panel) => {
        (panel.bubbles || []).forEach((b) => {
            if (b.characterId) appearingCharIds.add(b.characterId);
        });
    });

    const castPills = Array.from(appearingCharIds).map((cid) => {
        const ch = characters[cid] || { name: cid, emoji: '💬', voiceRole: 'narrator', badgeBg: '#FFE8EE' };
        const cloned = Boolean(isCharacterCloned(cid, ch.name));
        const fallbackRole = ch.voiceRole || (cid === 'narrator' ? 'narrator' : 'fairy');
        return `<button type="button"
            class="cast-pill cast-pill-btn ${cloned ? 'is-cloned' : ''}"
            data-char-id="${escapeHtml(cid)}"
            data-char-name="${escapeHtml(ch.name)}"
            data-char-emoji="${escapeHtml(ch.emoji || '🎙️')}"
            data-fallback-role="${escapeHtml(fallbackRole)}"
            title="点这里录制或管理「${escapeHtml(ch.name)}」的专属声音"
            style="--cast-bg:${escapeHtml(ch.badgeBg || '#FFE8EE')}">
            <span>${escapeHtml(ch.emoji || '')} ${escapeHtml(ch.name)}</span>
            <span class="cast-mic-tag">${cloned ? '✨已录' : '🎙️录声'}</span>
        </button>`;
    }).join('');

    const panelsHtml = panels.map((panel, pIdx) => {
        const capKey = buildComicCaptionSpeakKey(book.id, page.pageNumber, pIdx);
        const capActive = speakingKey === capKey ? 'is-speaking' : '';
        const captionHtml = panel.caption ? `
            <button type="button"
                class="comic-caption-btn ${capActive}"
                data-role="narrator"
                data-speak-key="${escapeHtml(capKey)}"
                data-panel-idx="${pIdx}"
                data-kind="caption">
                <span class="caption-badge">旁白</span>
                <span class="caption-text">${renderPinyinHtml(panel.caption, panel.captionPinyin)}</span>
            </button>
        ` : '';

        const stickersHtml = (panel.stickers || []).map((st) => {
            const styleCls = escapeHtml(st.style || 'pop-gold');
            const posCls = escapeHtml(st.pos || 'top-right');
            const rot = Number.isFinite(Number(st.rotate)) ? Number(st.rotate) : -6;
            return `<span class="comic-sticker ${styleCls} pos-${posCls}" style="--sticker-rot:${rot}deg">${escapeHtml(st.text)}</span>`;
        }).join('');

        const bubblesHtml = (panel.bubbles || []).map((b, bIdx) => {
            const ch = characters[b.characterId] || {
                name: b.characterId || '角色',
                emoji: '💬',
                voiceRole: 'narrator',
                bubbleBg: '#FFFDF7',
                bubbleBorder: '#5C4B99',
                badgeBg: '#EFEAFF'
            };
            const bKey = buildComicBubbleSpeakKey(book.id, page.pageNumber, pIdx, bIdx);
            const active = speakingKey === bKey ? 'is-speaking' : '';
            const sideCls = b.side === 'right' ? 'side-right' : 'side-left';
            const bubbleCloned = Boolean(isCharacterCloned(b.characterId, ch.name));
            return `
                <button type="button"
                    class="comic-bubble ${sideCls} ${active} ${bubbleCloned ? 'has-cloned-voice' : ''}"
                    data-kind="bubble"
                    data-panel-idx="${pIdx}"
                    data-bubble-idx="${bIdx}"
                    data-character="${escapeHtml(b.characterId)}"
                    data-character-name="${escapeHtml(ch.name)}"
                    data-role="${escapeHtml(ch.voiceRole || 'narrator')}"
                    data-speak-key="${escapeHtml(bKey)}"
                    style="--bubble-bg:${escapeHtml(ch.bubbleBg || '#FFFDF7')}; --bubble-border:${escapeHtml(ch.bubbleBorder || '#5C4B99')}; --badge-bg:${escapeHtml(ch.badgeBg || '#EFEAFF')};">
                    <span class="comic-bubble-tail" aria-hidden="true"></span>
                    <span class="bubble-header">
                        <span class="bubble-char-badge">${escapeHtml(ch.emoji || '')} ${escapeHtml(ch.name)}</span>
                        <span class="bubble-voice-icons">${bubbleCloned ? '<span class="bubble-cloned-tag">✨真声</span>' : ''}<span class="bubble-voice-icon" aria-hidden="true">🔊</span></span>
                    </span>
                    <span class="bubble-text">${renderPinyinHtml(b.text, b.pinyin)}</span>
                </button>
            `;
        }).join('');

        return `
            <div class="comic-panel panel-idx-${pIdx}" data-panel-idx="${pIdx}">
                <div class="comic-panel-bar">
                    <span class="comic-panel-label">第 ${pIdx + 1} 格</span>
                    <button type="button" class="btn-edit-panel" data-panel-idx="${pIdx}" aria-label="修改第 ${pIdx + 1} 格">✏️ 改这格</button>
                </div>
                ${captionHtml}
                <div class="comic-art-box">
                    <button type="button" class="comic-art-zoom-btn" data-zoom-src="${escapeHtml(panel.image)}" data-zoom-caption="${escapeHtml(panel.caption || page.title)}" aria-label="点击放大查看第 ${pIdx + 1} 格插画">
                        <img src="${escapeHtml(panel.image)}" alt="${escapeHtml(panel.caption || page.title)}" class="comic-panel-img" decoding="async"${pIdx === 0 ? ' fetchpriority="high"' : ''}>
                    </button>
                    ${stickersHtml}
                    <span class="panel-number-tag">${pIdx + 1}</span>
                </div>
                ${bubblesHtml ? `<div class="comic-bubbles-tray">${bubblesHtml}</div>` : ''}
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <section class="comic-sheet" data-page-number="${page.pageNumber}">
            <header class="comic-sheet-header">
                <div class="comic-title-row">
                    <span class="chapter-badge">${escapeHtml(book.emoji || '🐰')} 第 ${pageIndex + 1} / ${totalPages} 页</span>
                    <h2 class="comic-page-title">${renderPinyinHtml(page.title, page.titlePinyin)}</h2>
                    <button type="button" class="btn-edit-page btn-edit-page-sm" id="btn-edit-comic-page">✏️ 改这一页</button>
                </div>
                <div class="comic-cast-bar">
                    <div class="cast-pills">${castPills}</div>
                    <span class="comic-tap-tip">💡 点气泡听角色配音，点角色徽章可录真实声音！</span>
                </div>
            </header>
            <div class="comic-grid" data-layout="${escapeHtml(layout)}" data-panel-count="${panels.length}">
                ${panelsHtml}
            </div>
        </section>
    `;

    container.querySelectorAll('.cast-pill-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (typeof onOpenVoiceForCharacter === 'function') {
                onOpenVoiceForCharacter({
                    id: btn.getAttribute('data-char-id') || '',
                    name: btn.getAttribute('data-char-name') || '',
                    emoji: btn.getAttribute('data-char-emoji') || '🎙️',
                    fallbackRole: btn.getAttribute('data-fallback-role') || 'fairy'
                });
            }
        });
    });

    const editComicPageBtn = container.querySelector('#btn-edit-comic-page');
    if (editComicPageBtn && typeof onEditTarget === 'function') {
        editComicPageBtn.addEventListener('click', () => onEditTarget({
            scope: 'page',
            bookId: book.id,
            bookTitle: book.title,
            pageNumber: page.pageNumber,
            mode: 'comic'
        }));
    }

    container.querySelectorAll('.btn-edit-panel').forEach((btn) => {
        btn.addEventListener('click', () => {
            const pIdx = Number(btn.getAttribute('data-panel-idx'));
            if (typeof onEditTarget === 'function') {
                onEditTarget({
                    scope: 'panel',
                    bookId: book.id,
                    bookTitle: book.title,
                    pageNumber: page.pageNumber,
                    panelNumber: pIdx + 1,
                    mode: 'comic'
                });
            }
        });
    });

    container.querySelectorAll('.comic-art-zoom-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const src = btn.getAttribute('data-zoom-src');
            const caption = btn.getAttribute('data-zoom-caption') || '';
            if (src && typeof onZoomImage === 'function') {
                onZoomImage({ src, caption });
            }
        });
    });

    container.querySelectorAll('[data-kind="caption"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const pIdx = Number(btn.getAttribute('data-panel-idx'));
            const panel = panels[pIdx];
            if (panel && panel.caption && typeof onSpeakItem === 'function') {
                onSpeakItem({
                    text: panel.caption,
                    role: 'narrator',
                    characterId: 'narrator',
                    characterName: '故事姐姐',
                    speakKey: btn.getAttribute('data-speak-key')
                });
            }
        });
    });

    container.querySelectorAll('[data-kind="bubble"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const pIdx = Number(btn.getAttribute('data-panel-idx'));
            const bIdx = Number(btn.getAttribute('data-bubble-idx'));
            const bubble = panels[pIdx]?.bubbles?.[bIdx];
            const role = btn.getAttribute('data-role') || 'narrator';
            if (bubble && typeof onSpeakItem === 'function') {
                onSpeakItem({
                    text: bubble.text,
                    role,
                    characterId: bubble.characterId || '',
                    characterName: btn.getAttribute('data-character-name') || '',
                    speakKey: btn.getAttribute('data-speak-key')
                });
            }
        });
    });
}
