/**
 * pinyinRenderer.js - 二年级多音字精确注音渲染器
 * 按汉字逐字 1-to-1 匹配空格分隔的拼音音节生成 <ruby> 标签，标点、数字、Emoji 保持原样并做 XSS 转义。
 */

const HANZI_RE = /^[\u4e00-\u9fff]$/;

export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function countHanzi(text) {
    let count = 0;
    for (const ch of String(text ?? '')) {
        if (HANZI_RE.test(ch)) count++;
    }
    return count;
}

export function splitPinyinSyllables(pinyin) {
    const trimmed = String(pinyin ?? '').trim();
    if (!trimmed) return [];
    return trimmed.split(/\s+/);
}

/**
 * 将中文文本与精确拼音字符串渲染为可由 CSS 控制显隐的 <ruby> HTML 字符串
 */
export function renderPinyinHtml(text, pinyin = '') {
    const raw = String(text ?? '');
    if (!raw) return '';

    const syllables = splitPinyinSyllables(pinyin);
    const hanziCount = countHanzi(raw);
    const hasAlignedPinyin = syllables.length > 0 && syllables.length === hanziCount;

    if (!hasAlignedPinyin && syllables.length === 0) {
        return escapeHtml(raw);
    }

    let sylIdx = 0;
    let out = '';
    let plainBuf = '';

    const flushPlain = () => {
        if (plainBuf) {
            out += `<span class="py-punct">${escapeHtml(plainBuf)}</span>`;
            plainBuf = '';
        }
    };

    for (const ch of raw) {
        if (HANZI_RE.test(ch) && sylIdx < syllables.length) {
            flushPlain();
            const syl = syllables[sylIdx++];
            out += `<ruby class="py-char">${escapeHtml(ch)}<rt class="py-rt">${escapeHtml(syl)}</rt></ruby>`;
        } else {
            plainBuf += ch;
        }
    }
    flushPlain();
    return out;
}
