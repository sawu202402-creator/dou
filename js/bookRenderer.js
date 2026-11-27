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

/**
 * 渲染个人专属书架
 */
export function renderBookshelf(container, books, { latestBookId = '', updatedJustNow = false, onOpenBook, onOpenMailbox } = {}) {
    if (!container) return;

    const cardsHtml = (books || []).map((book) => {
        const isFresh = updatedJustNow && book.id === latestBookId;
        const tagsHtml = (book.tags || []).slice(0, 3).map(t => `<span class="shelf-tag">${escapeHtml(t)}</span>`).join('');
        return `
            <article class="book-card ${isFresh ? 'is-fresh' : ''}" data-book-id="${escapeHtml(book.id)}" tabindex="0" role="button" aria-label="打开《${escapeHtml(book.title)}》">
                ${isFresh ? '<div class="fresh-ribbon">✨ 刚刚上新</div>' : ''}
                <div class="book-cover-wrap">
                    <img src="${escapeHtml(book.cover)}" alt="${escapeHtml(book.title)}" class="book-cover-img" loading="eager">
                    <div class="book-spine-shine"></div>
                </div>
                <div class="book-card-body">
                    <h2 class="book-card-title">${escapeHtml(book.emoji || '📖')} ${escapeHtml(book.title)}</h2>
                    <p class="book-card-sub">${escapeHtml(book.subtitle || '')}</p>
                    <div class="book-card-meta">
                        <span class="page-pill">📖 ${Number(book.pageCount) || 1} 页</span>
                        <span class="mode-pill">绘本 · 漫画</span>
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

    container.innerHTML = `
        <section class="shelf-hero">
            <div class="shelf-hero-text">
                <h1>🐰 小豌豆的魔法书架</h1>
                <p>点开一本书，可以切换「精装绘本」或「多格漫画」两种阅读魔法哦！</p>
            </div>
            <div class="shelf-count-badge">📚 共 ${books.length} 本原创作品</div>
        </section>
        <div class="bookshelf-grid">
            ${cardsHtml}
            ${magicHintCard}
        </div>
    `;

    container.querySelectorAll('.book-card').forEach((card) => {
        const open = () => {
            const bookId = card.getAttribute('data-book-id');
            if (bookId && typeof onOpenBook === 'function') {
                onOpenBook(bookId);
            }
        };
        card.addEventListener('click', open);
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
}

/**
 * 模式 ①：精装有声绘本模式（左图右文翻页 + 二年级拼音开关 + 逐段/整页朗读）
 */
export function renderStorybookPage(container, book, page, {
    pageIndex = 0,
    totalPages = 1,
    speakingKey = '',
    onSpeakParagraph,
    onSpeakPage
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
                    <img src="${escapeHtml(page.illustration)}" alt="${escapeHtml(page.title)}" class="storybook-illustration">
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
                    <span class="storybook-tip">点任意一段文字也可以单独朗读哦</span>
                </footer>
            </div>
        </article>
    `;

    const artBtn = container.querySelector('#btn-storybook-art');
    const pageBtn = container.querySelector('#btn-read-storybook-page');
    if (artBtn && typeof onSpeakPage === 'function') {
        artBtn.addEventListener('click', () => onSpeakPage());
    }
    if (pageBtn && typeof onSpeakPage === 'function') {
        pageBtn.addEventListener('click', () => onSpeakPage());
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
 * 模式 ②：彩色多格漫画模式（分镜框 + 拟声词贴纸 + 点击角色对话气泡对应声线朗读）
 */
export function renderComicPage(container, book, page, {
    pageIndex = 0,
    totalPages = 1,
    speakingKey = '',
    onSpeakItem
} = {}) {
    if (!container || !book || !page) return;

    const characters = book.characters || {};
    const panels = page.panels || [];
    const layout = page.comicLayout || 'hero-top';

    // 收集本页出场角色作为图例
    const appearingCharIds = new Set();
    panels.forEach((panel) => {
        (panel.bubbles || []).forEach((b) => {
            if (b.characterId) appearingCharIds.add(b.characterId);
        });
    });

    const castPills = Array.from(appearingCharIds).map((cid) => {
        const ch = characters[cid] || { name: cid, emoji: '💬', badgeBg: '#FFE8EE' };
        return `<span class="cast-pill" style="--cast-bg:${escapeHtml(ch.badgeBg || '#FFE8EE')}">${escapeHtml(ch.emoji || '')} ${escapeHtml(ch.name)}</span>`;
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
            return `
                <button type="button"
                    class="comic-bubble ${sideCls} ${active}"
                    data-kind="bubble"
                    data-panel-idx="${pIdx}"
                    data-bubble-idx="${bIdx}"
                    data-character="${escapeHtml(b.characterId)}"
                    data-role="${escapeHtml(ch.voiceRole || 'narrator')}"
                    data-speak-key="${escapeHtml(bKey)}"
                    style="--bubble-bg:${escapeHtml(ch.bubbleBg || '#FFFDF7')}; --bubble-border:${escapeHtml(ch.bubbleBorder || '#5C4B99')}; --badge-bg:${escapeHtml(ch.badgeBg || '#EFEAFF')};">
                    <span class="comic-bubble-tail" aria-hidden="true"></span>
                    <span class="bubble-header">
                        <span class="bubble-char-badge">${escapeHtml(ch.emoji || '')} ${escapeHtml(ch.name)}</span>
                        <span class="bubble-voice-icon" aria-hidden="true">🔊</span>
                    </span>
                    <span class="bubble-text">${renderPinyinHtml(b.text, b.pinyin)}</span>
                </button>
            `;
        }).join('');

        return `
            <div class="comic-panel panel-idx-${pIdx}" data-panel-idx="${pIdx}">
                ${captionHtml}
                <div class="comic-art-box">
                    <img src="${escapeHtml(panel.image)}" alt="${escapeHtml(panel.caption || page.title)}" class="comic-panel-img">
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
                </div>
                <div class="comic-cast-bar">
                    <div class="cast-pills">${castPills}</div>
                    <span class="comic-tap-tip">💡 点对话气泡，听角色用自己的声音说话！</span>
                </div>
            </header>
            <div class="comic-grid" data-layout="${escapeHtml(layout)}" data-panel-count="${panels.length}">
                ${panelsHtml}
            </div>
        </section>
    `;

    container.querySelectorAll('[data-kind="caption"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const pIdx = Number(btn.getAttribute('data-panel-idx'));
            const panel = panels[pIdx];
            if (panel && panel.caption && typeof onSpeakItem === 'function') {
                onSpeakItem({
                    text: panel.caption,
                    role: 'narrator',
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
                    speakKey: btn.getAttribute('data-speak-key')
                });
            }
        });
    });
}
