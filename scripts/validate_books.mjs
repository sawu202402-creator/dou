#!/usr/bin/env node
/**
 * validate_books.mjs - 校验 version.json、books/manifest.json、每本书结构、插画文件、多音字拼音 1-to-1 对齐与声线合法性
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { countHanzi, splitPinyinSyllables } from '../js/pinyinRenderer.js';
import { ROLE_NEURAL_VOICES, generateSecMsGecV2, stripSpeechTextForTts } from '../edgeTtsMod.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAX_BOOK_IMAGE_BYTES = 350 * 1024;
const PRIMARY_STORY_ROLES = [
    'narrator', 'system_notice', 'pea', 'bunny', 'bear',
    'star_boy', 'prince', 'grandpa', 'fairy', 'cat', 'panda', 'succulent'
];

function readJson(relPath) {
    const abs = path.join(ROOT, relPath);
    assert.ok(fs.existsSync(abs), `缺少文件: ${relPath}`);
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function assertImageFile(relPath, label, referencedSet = null) {
    assert.ok(typeof relPath === 'string' && relPath.trim(), `${label} 缺少图片路径`);
    assert.ok(/\.webp$/i.test(relPath.trim()), `${label} 必须使用 .webp 高清轻量化图片: ${relPath}`);
    const abs = path.join(ROOT, relPath);
    assert.ok(fs.existsSync(abs), `${label} 图片文件不存在: ${relPath}`);
    const size = fs.statSync(abs).size;
    assert.ok(size > 1024, `${label} 图片文件过小（疑似损坏）: ${relPath} (${size} bytes)`);
    assert.ok(size <= MAX_BOOK_IMAGE_BYTES, `${label} 图片体积过大 (${Math.round(size / 1024)} KB > 350 KB): ${relPath}`);
    if (referencedSet) {
        referencedSet.add(path.resolve(abs));
    }
}

function assertPinyinAligned(text, pinyin, label) {
    assert.ok(typeof text === 'string' && text.trim(), `${label} 缺少 text`);
    assert.ok(typeof pinyin === 'string' && pinyin.trim(), `${label} 缺少 pinyin`);
    const hanziCount = countHanzi(text);
    const syllables = splitPinyinSyllables(pinyin);
    assert.equal(
        syllables.length,
        hanziCount,
        `${label} 拼音音节数(${syllables.length})与汉字数(${hanziCount})不一致！\n  text: ${text}\n  pinyin: ${pinyin}`
    );
}

function main() {
    // 1. 验证 edgeTtsMod 核心纯函数可用性及主声线均为 zh-CN-*
    const secMsGec = generateSecMsGecV2(1700000000);
    assert.match(secMsGec, /^[0-9A-F]{16}-[0-9A-F]{64}$/, 'Sec-MS-GEC v2 令牌格式异常');
    assert.equal(stripSpeechTextForTts('小豌豆🐰真棒！'), '小豌豆真棒！', 'stripSpeechTextForTts 清洗异常');
    for (const roleKey of PRIMARY_STORY_ROLES) {
        const cfg = ROLE_NEURAL_VOICES[roleKey];
        assert.ok(cfg?.voice?.startsWith('zh-CN-'), `故事屋核心角色 ${roleKey} 应使用大陆 zh-CN-* 声线，当前为 ${cfg?.voice}`);
    }

    // 2. 验证 version.json
    const versionData = readJson('version.json');
    for (const key of ['version', 'updatedAt', 'latestBookId', 'latestPage', 'changeType', 'summary', 'announcement']) {
        assert.ok(versionData[key] !== undefined && versionData[key] !== '', `version.json 缺少字段: ${key}`);
    }

    // 3. 验证 books/manifest.json
    const manifest = readJson('books/manifest.json');
    assert.ok(Array.isArray(manifest.books) && manifest.books.length > 0, 'books/manifest.json 的 books 数组不能为空');

    const validLayouts = new Set(['hero-top', 'hero-bottom', 'grid-2x2', 'strip-3']);
    let totalImagesChecked = 0;
    let totalPinyinChecked = 0;

    for (const entry of manifest.books) {
        assert.ok(entry.id && /^[a-z0-9-]+$/.test(entry.id), `非法 book id: ${entry.id}`);
        const referencedImages = new Set();
        assertImageFile(entry.cover, `manifest[${entry.id}].cover`, referencedImages);

        const bookRel = `books/${entry.id}/book.json`;
        const book = readJson(bookRel);
        assert.equal(book.id, entry.id, `${bookRel} 的 id 与 manifest 不一致`);
        assert.ok(book.artStyleBible && book.artStyleBible.length > 30, `${bookRel} 缺少 artStyleBible`);
        assertImageFile(book.cover, `${bookRel}.cover`, referencedImages);
        totalImagesChecked += 1;

        assertPinyinAligned(book.title, book.titlePinyin, `${bookRel}.title`);
        totalPinyinChecked += 1;

        assert.ok(book.characters && typeof book.characters === 'object', `${bookRel} 缺少 characters`);
        for (const [cid, ch] of Object.entries(book.characters)) {
            assert.ok(ch.name, `${bookRel}.characters.${cid} 缺少 name`);
            assert.ok(
                ch.voiceRole && Object.hasOwn(ROLE_NEURAL_VOICES, ch.voiceRole),
                `${bookRel}.characters.${cid} 的 voiceRole="${ch.voiceRole}" 未在 edgeTtsMod.js 中注册`
            );
        }

        assert.ok(Array.isArray(book.pages) && book.pages.length > 0, `${bookRel}.pages 不能为空`);
        assert.equal(book.pages.length, entry.pageCount, `manifest[${entry.id}].pageCount 与实际页数不符`);

        book.pages.forEach((page, idx) => {
            const pLabel = `${bookRel}.pages[${idx}]`;
            assert.equal(page.pageNumber, idx + 1, `${pLabel}.pageNumber 应为 ${idx + 1}`);
            assertPinyinAligned(page.title, page.titlePinyin, `${pLabel}.title`);
            totalPinyinChecked += 1;

            assertImageFile(page.illustration, `${pLabel}.illustration`, referencedImages);
            totalImagesChecked += 1;

            assert.ok(Array.isArray(page.storyParagraphs) && page.storyParagraphs.length > 0, `${pLabel}.storyParagraphs 不能为空`);
            page.storyParagraphs.forEach((para, paraIdx) => {
                assertPinyinAligned(para.text, para.pinyin, `${pLabel}.storyParagraphs[${paraIdx}]`);
                totalPinyinChecked += 1;
            });

            assert.ok(validLayouts.has(page.comicLayout), `${pLabel}.comicLayout="${page.comicLayout}" 非法`);
            assert.ok(Array.isArray(page.panels) && page.panels.length > 0, `${pLabel}.panels 不能为空`);

            page.panels.forEach((panel, panelIdx) => {
                const panLabel = `${pLabel}.panels[${panelIdx}]`;
                assertImageFile(panel.image, `${panLabel}.image`, referencedImages);
                totalImagesChecked += 1;

                if (panel.caption) {
                    assertPinyinAligned(panel.caption, panel.captionPinyin, `${panLabel}.caption`);
                    totalPinyinChecked += 1;
                }
                assert.ok(Array.isArray(panel.stickers), `${panLabel}.stickers 必须为数组`);
                assert.ok(Array.isArray(panel.bubbles), `${panLabel}.bubbles 必须为数组`);
                panel.bubbles.forEach((b, bIdx) => {
                    const bLabel = `${panLabel}.bubbles[${bIdx}]`;
                    assert.ok(Object.hasOwn(book.characters, b.characterId), `${bLabel}.characterId="${b.characterId}" 未在 characters 定义`);
                    assertPinyinAligned(b.text, b.pinyin, bLabel);
                    totalPinyinChecked += 1;
                });
            });
        });

        const imagesDir = path.join(ROOT, 'books', entry.id, 'images');
        if (fs.existsSync(imagesDir)) {
            for (const fname of fs.readdirSync(imagesDir)) {
                if (fname.startsWith('.')) continue;
                const full = path.resolve(imagesDir, fname);
                assert.ok(referencedImages.has(full), `发现未被 book.json 引用的孤儿图片: books/${entry.id}/images/${fname}`);
            }
        }
    }

    console.log(
        `✅ validate_books passed: ${manifest.books.length} book(s), ${totalImagesChecked} image reference(s) verified, ${totalPinyinChecked} pinyin line(s) 1-to-1 aligned, version=${versionData.version}`
    );
}

main();
