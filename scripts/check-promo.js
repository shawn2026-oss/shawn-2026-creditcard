/**
 * 自動檢查活動額滿狀態(puppeteer 版 v2.3.1)
 * GitHub Actions 每天台灣時間 00/08/14/20 點執行
 *
 * ⚠️ workflow 需要加 pdf-parse 套件:
 *    npm install puppeteer pdf-parse
 *
 * v2.3.1 修正:
 *   - detectFull() 加「活動期間」排除規則,避免活動起訖日期被誤判為額滿時間
 *     (例如 1766109563 頁面的「2026/4/1 01:59」是活動結束日,不是額滿日)
 *   - challenge 銀/金/白金判定改寬鬆邏輯:先看硬 regex,再用「級別+額滿」上下文
 *   - 新增 scanQuotaReachedPdf():爬悠遊卡官方 quotareached.pdf 拿到月級挑戰額滿資料
 *     當網頁版沒即時更新時,PDF 是第二來源
 *
 * v2.3 修正:
 *   - detectFull() 涵蓋悠遊付格式「X/D (週) HH:MM 額滿」「MM/DD HH:MM:SS額滿」
 *   - 爬 C1/C2 時順便抓 epkaw 連結
 *   - 新增 scanEpkaw() 處理 epkaw advertisement/{UUID} 頁面
 *
 * v2.2 修正:
 *   - icash Pay 改用列表頁自動發現
 *
 * v2.1 修正:
 *   - id/2019 額滿上下文判定 + online3c/transport 的 msg 脫 HTML
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const puppeteer = require('puppeteer');

// pdf-parse 是選用的——如果 workflow 沒安裝也能跑(月級挑戰走 web 那邊)
let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch (e) { console.log('[info] pdf-parse 未安裝,將跳過 PDF 掃描'); }

const STATUS_FILE = 'promo_status.json';

// ===== 基礎工具 =====

function fetchPage(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(''), timeout);
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        res.resume();
        return fetchPage(next, timeout).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { clearTimeout(timer); resolve(data); });
    }).on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 抓二進位內容(for PDF) */
function fetchBuffer(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeout);
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        res.resume();
        return fetchBuffer(next, timeout).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    }).on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function fetchPageWithCookie(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { resolve(''); }, 10000);
    let redirectCount = 0, allCookies = '';
    function doGet(targetUrl) {
      if (redirectCount++ > 5) { clearTimeout(timer); resolve(''); return; }
      const headers = { 'User-Agent': 'Mozilla/5.0' };
      if (allCookies) headers['Cookie'] = allCookies;
      const mod = targetUrl.startsWith('https') ? https : http;
      mod.get(targetUrl, { headers }, (res) => {
        const sc = res.headers['set-cookie'];
        if (sc) { const nc = sc.map(c => c.split(';')[0]).join('; '); allCookies = allCookies ? allCookies + '; ' + nc : nc; }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const ru = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, targetUrl).href;
          res.resume(); return doGet(ru);
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { clearTimeout(timer); resolve(data); });
      }).on('error', (e) => { clearTimeout(timer); reject(e); });
    }
    doGet(url);
  });
}

function getMonthStr() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return { year, month, monthNum: String(now.getMonth() + 1), todayStr: `${year}-${month}-${String(now.getDate()).padStart(2, '0')}` };
}

function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// ===== 額滿偵測(通用,v2.3.1) =====

/**
 * 判斷文字是否包含本月的真實額滿公告。
 *
 * 策略:只信任「明確記錄了額滿時間點」的句型。
 * 拒絕:「額滿即止」「於 APP 公告額滿狀態」等制度性文字。
 *
 * 實作:
 *   1. 掃描每個「額滿」位置
 *   2. 取前 30 字窄窗口(要求時間點緊鄰「額滿」)
 *   3. 窗口必須同時含:本月日期 + HH:MM 時間標記
 *   4. 額外排除:窗口內含「起」「~」「至」等範圍符號(代表是活動期間而非單一時間點)
 *   5. 排除歷史年份
 */
function detectFull(text, year, monthNum, month) {
  const plain = typeof text === 'string' ? text : String(text);
  if (!plain || !plain.includes('額滿')) return false;

  const mm = monthNum.padStart(2, '0');

  // 本月日期:M/D 或 MM/DD 或 YYYY/M/D
  const monthDateRx = new RegExp(
    `(?:^|[^0-9/])(?:${year}[年/])?(?:${monthNum}|${mm})[/月]\\s*\\d{1,2}`
  );
  // 時間標記:HH:MM / HH:MM:SS / am / pm
  const realTimeRx = /\d{1,2}:\d{2}(?::\d{2})?|[ap]\.?\s?m\.?/i;
  // 範圍符號(表示這是活動期間,不是單一時間點)
  const rangeRx = /起[\s~～\-]|~\s*20\d{2}|至\s*20\d{2}|[~～\-]\s*(?:20\d{2}|\d{1,2}\/\d{1,2})/;
  const otherYearRx = new RegExp(`(${year - 1}|${year - 2}|${year + 1})年`);

  const fullRx = /額滿/g;
  let m;
  while ((m = fullRx.exec(plain)) !== null) {
    // 窄窗口:取「額滿」前 25 字
    // 真實句型如「已於 2026/04/04 17:21 p.m. 額滿」最多 22 字
    // 設太大會吃到前一句的「活動期間」造成誤判
    const start = Math.max(0, m.index - 25);
    const ctx = plain.substring(start, m.index);

    // 條件 1:窗口含本月日期
    if (!monthDateRx.test(ctx)) continue;

    // 條件 2:窗口含 HH:MM 時間點
    if (!realTimeRx.test(ctx)) continue;

    // 條件 3:窗口不能是範圍表達(活動期間)
    if (rangeRx.test(ctx)) continue;

    // 條件 4:排除歷史年份
    if (otherYearRx.test(ctx)) continue;

    return true;
  }

  return false;
}

function extractTitle(html) {
  let m = html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (m && m[1]) {
    const t = m[1].replace(/-悠遊卡股份有限公司/, '').replace(/悠遊付｜.*/, '').replace(/\s+/g, ' ').trim();
    if (t.length > 2 && t.length < 80) return t;
  }
  m = html.match(/<meta\s+(?:property|name)=["']og:title["']\s+content=["'](.*?)["']/i);
  if (m && m[1]) {
    const t = m[1].replace(/-悠遊卡股份有限公司/, '').replace(/\s+/g, ' ').trim();
    if (t.length > 2 && t.length < 80) return t;
  }
  m = html.match(/<h[12][^>]*>(.*?)<\/h[12]>/i);
  if (m && m[1]) {
    const t = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (t.length > 2 && t.length < 80) return t;
  }
  return '';
}

function cleanLabel(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/悠遊卡股份有限公司/g, '')
    .trim()
    .substring(0, 50);
}

// ===== 悠遊付月級挑戰:掃 quotareached.pdf =====

/**
 * 爬 https://www.easycard.com.tw/_upload/files/quotareached.pdf
 * PDF 格式:
 *   每月額滿時間  白金級         金級           銀級
 *   1月          1/13 11:50:26  1/11 14:53:33  1/9 10:19:34
 *   2月          2/11 00:01:26  2/11 06:57:22  2/9 09:01:02
 *   ...
 *
 * 回傳當月的三個子級別狀態。
 */
async function scanQuotaReachedPdf(monthNum) {
  if (!pdfParse) {
    console.log('[PDF] pdf-parse 未安裝,跳過');
    return { silver: false, gold: false, platinum: false };
  }

  try {
    const buf = await fetchBuffer('https://www.easycard.com.tw/_upload/files/quotareached.pdf');
    if (!buf || buf.length < 100) {
      console.log('[PDF] 下載失敗或檔案過小');
      return { silver: false, gold: false, platinum: false };
    }

    const parsed = await pdfParse(buf);
    const text = parsed.text || '';
    console.log(`[PDF] 內容: "${text.replace(/\s+/g, ' ').substring(0, 200)}..."`);

    // 找 "N月 M/D HH:MM:SS M/D HH:MM:SS M/D HH:MM:SS" 列
    const lines = text.split(/\r?\n/);
    const rowRx = new RegExp(
      `^\\s*${monthNum}月\\s+` +
      `(\\d{1,2}/\\d{1,2}\\s+[\\d:]+)\\s+` +   // 白金
      `(\\d{1,2}/\\d{1,2}\\s+[\\d:]+)\\s+` +   // 金
      `(\\d{1,2}/\\d{1,2}\\s+[\\d:]+)`          // 銀
    );

    for (const line of lines) {
      const m = line.match(rowRx);
      if (m) {
        console.log(`[PDF] 找到 ${monthNum} 月:白金=${m[1]} 金=${m[2]} 銀=${m[3]}`);
        return {
          platinum: { full: true, time: m[1].trim() },
          gold: { full: true, time: m[2].trim() },
          silver: { full: true, time: m[3].trim() },
        };
      }
    }

    console.log(`[PDF] 未找到 ${monthNum} 月的額滿記錄(PDF 可能還沒更新)`);
    return { silver: false, gold: false, platinum: false };
  } catch (e) {
    console.error('[PDF] 解析失敗:', e.message);
    return { silver: false, gold: false, platinum: false };
  }
}

// ===== icash Pay 列表頁自動發現 =====

async function discoverIcashPayPages() {
  const buckets = {
    uniopen_4pct: [],
    starbucks_5pct: [],
    transport_10pct: [],
    online3c_10pct: [],
    sunday_7pct: [],
  };
  const seenIds = new Set();

  for (let pageNum = 1; pageNum <= 5; pageNum++) {
    const url = pageNum === 1
      ? 'https://www.icashpay.com.tw/advertMessage/index'
      : `https://www.icashpay.com.tw/advertMessage/index/page/${pageNum}`;
    let html = '';
    try {
      html = await fetchPage(url);
    } catch (e) {
      console.error(`[icash Pay 列表] page ${pageNum} 失敗:`, e.message);
      continue;
    }
    if (!html || html.length < 500) {
      console.log(`[icash Pay 列表] page ${pageNum} 內容過短,跳過`);
      continue;
    }

    const linkRx = /<a[^>]*href=["']([^"']*advertMessage\/view\/id\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    let foundInPage = 0;
    while ((match = linkRx.exec(html)) !== null) {
      const href = match[1];
      const id = match[2];
      const inner = match[3];

      if (seenIds.has(id)) continue;
      seenIds.add(id);

      let title = stripHtml(inner);

      if (title.length < 5) {
        const afterIdx = match.index + match[0].length;
        const after = html.substring(afterIdx, afterIdx + 400);
        title = stripHtml(after).substring(0, 100);
      }
      if (!title) continue;

      const fullUrl = href.startsWith('http')
        ? href
        : `https://www.icashpay.com.tw${href.startsWith('/') ? '' : '/'}${href}`;
      const entry = { id, url: fullUrl, title };

      let classified = false;

      if (/星巴克|starbucks/i.test(title) && /5\s*%|筆筆/.test(title)) {
        buckets.starbucks_5pct.push(entry);
        classified = true;
      }
      if (/(網購|3\s*C|數位|電商)/.test(title) && /10\s*%/.test(title)) {
        buckets.online3c_10pct.push(entry);
        classified = true;
      }
      if (/(交通|捷運|公車|大眾運輸|YouBike|iPASS|悠遊)/.test(title) && /10\s*%/.test(title)) {
        buckets.transport_10pct.push(entry);
        classified = true;
      }
      if (/週日|星期日|日曜/.test(title) && /7\s*%/.test(title)) {
        buckets.sunday_7pct.push(entry);
        classified = true;
      }
      if (!classified && /uniopen|UNIOPEN|全通路|天天最高|天天回饋/i.test(title)) {
        buckets.uniopen_4pct.push(entry);
        classified = true;
      }
      if (classified) foundInPage++;
    }
    console.log(`[icash Pay 列表] page ${pageNum}: 分類到 ${foundInPage} 個活動`);
  }

  const FALLBACK = [
    { bucket: 'uniopen_4pct', id: '2019', title: '[fallback] id/2019' },
    { bucket: 'uniopen_4pct', id: '1982', title: '[fallback] id/1982' },
    { bucket: 'starbucks_5pct', id: '2019', title: '[fallback] id/2019' },
    { bucket: 'starbucks_5pct', id: '1982', title: '[fallback] id/1982' },
    { bucket: 'transport_10pct', id: '2037', title: '[fallback] id/2037' },
    { bucket: 'online3c_10pct', id: '2033', title: '[fallback] id/2033' },
    { bucket: 'sunday_7pct', id: '1954', title: '[fallback] id/1954' },
  ];
  for (const f of FALLBACK) {
    if (!buckets[f.bucket].some(e => e.id === f.id)) {
      buckets[f.bucket].push({
        id: f.id,
        url: `https://www.icashpay.com.tw/advertMessage/view/id/${f.id}`,
        title: f.title
      });
    }
  }

  for (const [bucketName, entries] of Object.entries(buckets)) {
    console.log(`[icash Pay 分類] ${bucketName}: ${entries.length} 個`);
    for (const e of entries) {
      console.log(`    id/${e.id}  "${e.title.substring(0, 60)}"`);
    }
  }

  return buckets;
}

async function scanIcashPayBucket(entries, year, monthNum, { subMatch, excludeSubMatch } = {}) {
  const mm = monthNum.padStart(2, '0');
  const monthRx = new RegExp(
    `(${year}年${monthNum}月|${year}/${mm}|${year}/${monthNum}|(?<![0-9])${mm}月|(?<![0-9])${monthNum}月份)`
  );

  for (const entry of entries) {
    let html = '';
    try {
      html = await fetchPage(entry.url);
    } catch (e) {
      console.log(`  [id/${entry.id}] 取頁失敗:`, e.message);
      continue;
    }
    if (!html || html.length < 200) continue;

    const plainText = stripHtml(html);

    const fullRx = /額滿/g;
    let fm;
    while ((fm = fullRx.exec(plainText)) !== null) {
      const start = Math.max(0, fm.index - 150);
      const end = Math.min(plainText.length, fm.index + 50);
      const ctx = plainText.substring(start, end);

      if (!monthRx.test(ctx)) continue;
      if (excludeSubMatch && excludeSubMatch.test(ctx)) continue;
      if (subMatch && !subMatch.test(ctx)) continue;

      return {
        full: true,
        sourceId: entry.id,
        snippet: ctx.trim().substring(0, 100),
      };
    }
  }

  return { full: false, sourceId: null, snippet: null };
}

// ===== 悠遊付:URL 收集 =====

async function collectEasycardOfferUrls(browser) {
  const seen = new Set();
  const results = [];

  function addUrl(id, url, source, label, special) {
    if (!seen.has(id)) {
      seen.add(id);
      results.push({ id, url, source, label: label || '', special });
    } else if (label) {
      const existing = results.find(r => r.id === id);
      if (existing && !existing.label) existing.label = label;
    }
  }

  // --- C1: easycard.com.tw/offers 列表頁 ---
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    const listUrl = 'https://www.easycard.com.tw/offers';
    console.log('[C1] 載入 easycard.com.tw/offers 列表頁...');
    await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    for (let pageNum = 1; pageNum <= 5; pageNum++) {
      await page.evaluate(async () => {
        for (let i = 0; i < 8; i++) {
          window.scrollBy(0, 600);
          await new Promise(r => setTimeout(r, 300));
        }
      });
      await new Promise(r => setTimeout(r, 1500));

      const items = await page.$$eval('a[href*="offer"]', as =>
        as.filter(a => a.href.includes('id=') && a.href.includes('easycard.com.tw'))
          .map(a => {
            const card = a.closest('.card, .item, .offer-item, li, article, .col');
            let label = '';
            const img = (card || a).querySelector('img[alt]');
            if (img && img.alt) label = img.alt;
            if (!label) label = a.textContent.trim();
            if (!label && card) label = card.textContent.trim().substring(0, 80);
            return { href: a.href, label };
          })
      );

      let newCount = 0;
      for (const item of items) {
        const idMatch = item.href.match(/id=(\d+)/);
        if (idMatch) {
          const before = seen.size;
          addUrl(idMatch[1], item.href, 'easycard_list', cleanLabel(item.label));
          if (seen.size > before) newCount++;
        }
      }
      console.log(`[C1] 第 ${pageNum} 頁: ${items.length} 個連結,新增 ${newCount} 個`);

      const epkawLinks = await page.$$eval('a[href*="epkaw.easycard.com.tw/advertisement"]', as =>
        as.map(a => {
          const card = a.closest('.card, .item, .offer-item, li, article, .col');
          let label = '';
          const img = (card || a).querySelector('img[alt]');
          if (img && img.alt) label = img.alt;
          if (!label) label = a.textContent.trim();
          if (!label && card) label = card.textContent.trim().substring(0, 80);
          return { href: a.href, label };
        })
      );
      for (const item of epkawLinks) {
        const uuidMatch = item.href.match(/advertisement\/([a-f0-9-]+)/i);
        if (uuidMatch) {
          addUrl('epkaw_' + uuidMatch[1].substring(0, 13), item.href, 'c1_epkaw', cleanLabel(item.label));
        }
      }
      if (epkawLinks.length) console.log(`[C1] 第 ${pageNum} 頁: 抓到 ${epkawLinks.length} 個 epkaw 連結`);

      const hasNext = await page.evaluate((currentPage) => {
        const pageLinks = document.querySelectorAll('.pagination a, .page-link, .pager a, a[href*="page="]');
        for (const a of pageLinks) {
          const text = a.textContent.trim();
          if (text === String(currentPage + 1) || text === '下一頁' || text === '>' || text === '»') {
            a.click();
            return true;
          }
        }
        const nextPageLink = document.querySelector(`a[href*="page=${currentPage + 1}"]`);
        if (nextPageLink) { nextPageLink.click(); return true; }
        return false;
      }, pageNum);

      if (!hasNext) {
        console.log(`[C1] 無下一頁,共 ${pageNum} 頁`);
        break;
      }
      await new Promise(r => setTimeout(r, 2000));
      await page.waitForNetworkIdle({ timeout: 8000 }).catch(() => {});
    }
    await page.close();
  } catch (e) {
    console.error('[C1] easycard 列表頁失敗:', e.message);
  }

  // --- C2: easywallet.easycard.com.tw/benefit 列表頁 ---
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    console.log('[C2] 載入 easywallet 好康優惠列表頁...');
    await page.goto('https://easywallet.easycard.com.tw/benefit', { waitUntil: 'networkidle2', timeout: 30000 });

    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await new Promise(r => setTimeout(r, 400));
    }
    await new Promise(r => setTimeout(r, 1500));

    const items = await page.$$eval('a[href*="benefit/content"]', as =>
      as.filter(a => a.href.includes('id='))
        .map(a => {
          const card = a.closest('.card, .item, .benefit-item, li, article, div[class]');
          let label = '';
          const img = (card || a).querySelector('img[alt]');
          if (img && img.alt) label = img.alt;
          if (!label) label = a.textContent.trim();
          if (!label && card) label = card.textContent.trim().substring(0, 80);
          return { href: a.href, label };
        })
    );

    for (const item of items) {
      const idMatch = item.href.match(/id=(\d+)/);
      if (idMatch) {
        addUrl('ew_' + idMatch[1], item.href, 'easywallet_list', cleanLabel(item.label));
      }
    }
    console.log(`[C2] easywallet 列表: ${items.length} 個連結`);

    const epkawLinks = await page.$$eval('a[href*="epkaw.easycard.com.tw/advertisement"]', as =>
      as.map(a => {
        const card = a.closest('.card, .item, .benefit-item, li, article, div[class]');
        let label = '';
        const img = (card || a).querySelector('img[alt]');
        if (img && img.alt) label = img.alt;
        if (!label) label = a.textContent.trim();
        if (!label && card) label = card.textContent.trim().substring(0, 80);
        return { href: a.href, label };
      })
    );
    for (const item of epkawLinks) {
      const uuidMatch = item.href.match(/advertisement\/([a-f0-9-]+)/i);
      if (uuidMatch) {
        addUrl('epkaw_' + uuidMatch[1].substring(0, 13), item.href, 'c2_epkaw', cleanLabel(item.label));
      }
    }
    if (epkawLinks.length) console.log(`[C2] 額外抓到 ${epkawLinks.length} 個 epkaw 連結`);

    await page.close();
  } catch (e) {
    console.error('[C2] easywallet 列表頁失敗:', e.message);
  }

  // --- C3: hardcoded 保底清單 ---
  const KNOWN_URLS = [
    { id: 'challenge_1766109563', url: 'https://easywallet.easycard.com.tw/benefit/content?id=1766109563', label: '月級挑戰', special: 'challenge' },
    { id: 'ew_1771988018', url: 'https://www.easycard.com.tw/offer?id=1771988018', label: '乘車碼10%回饋' },
    { id: 'ew_1766377676', url: 'https://easywallet.easycard.com.tw/benefit/content?id=1766377676', label: '新會員3%回饋' },
    { id: 'ew_1766573956', url: 'https://www.easycard.com.tw/offer?id=1766573956', label: '推薦好友送$100' },
  ];

  let hardcodedAdded = 0;
  for (const item of KNOWN_URLS) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      results.push({ id: item.id, url: item.url, source: 'hardcoded', label: item.label, special: item.special });
      hardcodedAdded++;
    } else {
      const existing = results.find(r => r.id === item.id);
      if (existing) {
        if (!existing.label && item.label) existing.label = item.label;
        if (!existing.special && item.special) existing.special = item.special;
      }
    }
  }
  console.log(`[C3] hardcoded 保底: 補充 ${hardcodedAdded} 個`);
  console.log(`\n[悠遊付] 總計 ${results.length} 個活動 URL`);
  return results;
}

async function fetchSpaPage(browser, url, timeout = 12000) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
    const title = await page.title().catch(() => '');
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    await page.close();
    return { title, text };
  } catch (e) {
    await page.close();
    return { title: '', text: '' };
  }
}

// ===== 主程式 =====

async function checkPromo() {
  const startTime = Date.now();
  const { year, month, monthNum, todayStr } = getMonthStr();
  let currentStatus = {};
  try { currentStatus = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch (e) { console.log('無現有狀態檔'); }

  const lastMonth = (currentStatus.updated || '').substring(0, 7);
  const thisMonth = todayStr.substring(0, 7);
  const needReset = thisMonth !== lastMonth && new Date().getDate() <= 3;
  function prev(key) { return needReset ? false : (currentStatus[key] || false); }

  const promos = [];

  // ========== A. icash Pay ==========

  console.log('\n===== icash Pay 列表自動發現 =====');
  const icashBuckets = await discoverIcashPayPages();

  // --- A1. UNIOPEN 全通路 4% ---
  let icashFull = prev('uniopen_icash_full'), icashMsg = needReset ? '' : (currentStatus.uniopen_icash_msg || '');
  try {
    const result = await scanIcashPayBucket(icashBuckets.uniopen_4pct, year, monthNum, {
      subMatch: /全通路|不限金額|4\s*%/,
      excludeSubMatch: /星巴克|筆筆5%/,
    });
    if (result.full && !icashFull) {
      icashFull = true;
      icashMsg = `${year}年${monthNum}月 icash Pay 4%已額滿`;
      console.log(`[icash Pay 4%] 額滿 ← id/${result.sourceId} "${result.snippet}"`);
    } else if (!icashFull) {
      console.log('[icash Pay 4%] 未額滿');
    }
  } catch (e) { console.error('[icash Pay 4%] 失敗:', e.message); }
  if (icashFull) promos.push({ id: 'icash_4', full: true, title: 'icash Pay 4%已額滿', body: `icash Pay 全通路4% ${monthNum}月名額已滿`, category: 'icash Pay' });

  // --- A2. 星巴克 5% ---
  let starbucksFull = prev('starbucks_5_full'), starbucksMsg = needReset ? '' : (currentStatus.starbucks_5_msg || '');
  try {
    const combined = [...icashBuckets.starbucks_5pct, ...icashBuckets.uniopen_4pct];
    const result = await scanIcashPayBucket(combined, year, monthNum, {
      subMatch: /星巴克|筆筆回饋5%|筆筆饋5%|筆筆5%/,
    });
    if (result.full && !starbucksFull) {
      starbucksFull = true;
      starbucksMsg = `${year}年${monthNum}月 星巴克筆筆5%已額滿`;
      console.log(`[星巴克 5%] 額滿 ← id/${result.sourceId} "${result.snippet}"`);
    } else if (!starbucksFull) {
      console.log('[星巴克 5%] 未額滿');
    }
  } catch (e) { console.error('[星巴克 5%] 失敗:', e.message); }
  if (starbucksFull) promos.push({ id: 'starbucks_5', full: true, title: '星巴克5%已額滿', body: `icash Pay 星巴克5% ${monthNum}月名額已滿`, category: 'icash Pay' });

  // --- A3. 交通 10% ---
  const banks = ['台新', '兆豐', '一銀', '華南', '元大'];
  let transport = currentStatus.transport_10 || {};
  if (needReset) { transport = {}; for (const b of banks) transport[b] = { full: false, msg: '' }; }
  else { for (const b of banks) if (!transport[b]) transport[b] = { full: false, msg: '' }; }

  try {
    for (const entry of icashBuckets.transport_10pct) {
      let html = '';
      try { html = await fetchPage(entry.url); } catch (e) { continue; }
      if (!html) continue;
      const plainP = stripHtml(html);
      for (const b of banks) {
        if (transport[b].full) continue;
        const m = plainP.match(new RegExp(b + monthNum.padStart(2, '0') + '月份贈點已於[\\s\\S]*?額滿'));
        if (m) {
          transport[b].full = true;
          transport[b].msg = stripHtml(m[0]);
          console.log(`[交通 10%] ${b} 額滿 ← id/${entry.id}`);
        }
      }
    }
    for (const b of banks) {
      if (!transport[b].full) console.log(`[交通 10%] ${b} 未額滿`);
    }
  } catch (e) { console.error('[交通 10%] 失敗:', e.message); }

  for (const b of banks) {
    if (transport[b].full) promos.push({ id: `transport_${b}`, full: true, title: `交通10%額滿(${b})`, body: `icash Pay 交通10% ${b} ${monthNum}月名額已滿`, category: 'icash Pay' });
  }

  // --- A4. 週日 7% ---
  let sundayFull = prev('sunday_7_full'), sundayMsg = needReset ? '' : (currentStatus.sunday_7_msg || '');
  try {
    const result = await scanIcashPayBucket(icashBuckets.sunday_7pct, year, monthNum, {
      subMatch: /週日|星期日/,
    });
    if (result.full && !sundayFull) {
      sundayFull = true;
      sundayMsg = `${year}年${monthNum}月 週日7%已額滿`;
      console.log(`[週日 7%] 額滿 ← id/${result.sourceId}`);
    } else if (!sundayFull) {
      console.log('[週日 7%] 未額滿');
    }
  } catch (e) { console.error('[週日 7%] 失敗:', e.message); }
  if (sundayFull) promos.push({ id: 'sunday_7', full: true, title: '週日7%已額滿', body: `icash Pay 週日7% ${monthNum}月名額已滿`, category: 'icash Pay' });

  // --- A5. 網購 3C 10% ---
  const banks3c = ['玉山', '國泰', '台新', '富邦', '兆豐'];
  let online3c = currentStatus.online3c_10 || {};
  if (needReset) { online3c = {}; for (const b of banks3c) online3c[b] = { full: false, msg: '' }; }
  else { for (const b of banks3c) if (!online3c[b]) online3c[b] = { full: false, msg: '' }; }

  try {
    for (const entry of icashBuckets.online3c_10pct) {
      let html = '';
      try { html = await fetchPage(entry.url); } catch (e) { continue; }
      if (!html) continue;
      const plainP = stripHtml(html);
      for (const b of banks3c) {
        if (online3c[b].full) continue;
        const m = plainP.match(new RegExp(b + monthNum.padStart(2, '0') + '月份贈點已於[\\s\\S]*?額滿'));
        if (m) {
          online3c[b].full = true;
          online3c[b].msg = stripHtml(m[0]);
          console.log(`[網購3C 10%] ${b} 額滿 ← id/${entry.id}`);
        }
      }
    }
    for (const b of banks3c) {
      if (!online3c[b].full) console.log(`[網購3C 10%] ${b} 未額滿`);
    }
  } catch (e) { console.error('[網購3C 10%] 失敗:', e.message); }

  for (const b of banks3c) {
    if (online3c[b].full) promos.push({ id: `online3c_${b}`, full: true, title: `網購3C 10%額滿(${b})`, body: `icash Pay 網購3C 10% ${b} ${monthNum}月名額已滿`, category: 'icash Pay' });
  }

  // ========== B. icash2.0 ==========

  let autoloadFull = prev('uniopen_autoload_full'), autoloadMsg = needReset ? '' : (currentStatus.uniopen_autoload_msg || '');
  try {
    const raw = await fetchPageWithCookie('https://www.icash.com.tw/Home/NewsDetail?ID=12654');
    const t = raw.replace(/<[^>]+>/g, '');
    if (t.length > 100 && t.match(new RegExp(monthNum + '月[\\s\\S]*?加值[\\s\\S]*?額滿'))) {
      autoloadFull = true; autoloadMsg = `${year}年${monthNum}月 uniopen自動加值10%已額滿`; console.log('[ID=12654] 額滿');
    } else console.log('[ID=12654] 未額滿或頁面過短');
  } catch (e) { console.error('[ID=12654] 失敗:', e.message); }
  if (autoloadFull) promos.push({ id: 'uniopen_autoload', full: true, title: '自動加值10%已額滿', body: `uniopen自動加值10% ${monthNum}月名額已滿`, category: 'icash2.0' });

  // ========== B2. 聯邦銀行 iPASS MONEY 10% ==========
  let ubotIpass = currentStatus.ubot_ipassmoney || {};
  const ipassMonths = ['1', '2', '3', '4', '5', '6'];
  if (needReset) {
    ubotIpass = {};
    for (const m of ipassMonths) ubotIpass[m] = { full: false, msg: '' };
  } else {
    for (const m of ipassMonths) if (!ubotIpass[m]) ubotIpass[m] = { full: false, msg: '' };
  }
  try {
    const p = await fetchPage('https://activity.ubot.com.tw/aws_act/2026/2026ipassmoney/index.htm');
    for (const m of ipassMonths) {
      const rx = new RegExp(m + '月活動已額滿');
      if (p.match(rx)) {
        ubotIpass[m].full = true;
        ubotIpass[m].msg = `${m}月活動已額滿`;
        console.log(`[聯邦iPASS] ${m}月 額滿`);
      } else if (!ubotIpass[m].full) {
        console.log(`[聯邦iPASS] ${m}月 未額滿`);
      }
    }
  } catch (e) { console.error('[聯邦iPASS] 失敗:', e.message); }
  if (ubotIpass[monthNum] && ubotIpass[monthNum].full) {
    promos.push({
      id: `ubot_ipassmoney_${monthNum}`,
      full: true,
      title: `聯邦iPASS MONEY 10%額滿(${monthNum}月)`,
      body: `聯邦信用卡綁定iPASS MONEY 10%綠點 ${monthNum}月名額已滿`,
      category: '聯邦'
    });
  }

  // ========== C. 悠遊付 ==========

  const tAB = Date.now();
  console.log(`\n[計時] A+B: ${((tAB - startTime) / 1000).toFixed(1)}s`);
  console.log('===== 悠遊付掃描 =====');

  // --- C0. 優先:quotareached.pdf 掃月級挑戰 ---
  console.log('[C0] 掃官方 quotareached.pdf...');
  const pdfChallenge = await scanQuotaReachedPdf(monthNum);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  let offerUrls = [];
  try {
    offerUrls = await collectEasycardOfferUrls(browser);
  } catch (e) {
    console.error('[悠遊付] URL 收集失敗:', e.message);
  }

  const tC123 = Date.now();
  console.log(`[計時] C URL收集: ${((tC123 - tAB) / 1000).toFixed(1)}s`);

  console.log('\n===== 悠遊付逐頁掃描額滿 =====');
  const ecardResults = {};

  const epkawItems = offerUrls.filter(i => i.url.includes('epkaw.easycard.com.tw/advertisement'));
  const spaItems = offerUrls.filter(i => i.url.includes('easywallet.easycard.com.tw'));
  const ssrItems = offerUrls.filter(i =>
    !i.url.includes('easywallet.easycard.com.tw') &&
    !i.url.includes('epkaw.easycard.com.tw')
  );

  console.log(`SSR(easycard): ${ssrItems.length} 個, SPA(easywallet): ${spaItems.length} 個, epkaw: ${epkawItems.length} 個`);

  async function scanSsr(item) {
    try {
      const html = await fetchPage(item.url);
      const text = stripHtml(html);
      const pageTitle = extractTitle(html);
      const title = item.label || pageTitle || `悠遊付活動 ${item.id}`;

      const hasCapMechanism = /額滿即止|名額有限|名額已滿|額滿/.test(text);
      if (!hasCapMechanism) return;

      const full = detectFull(text, year, monthNum, month);
      ecardResults[item.id] = { full, title: title.substring(0, 50) };
      console.log(`[SSR] ${title.substring(0, 40)} → ${full ? '額滿' : '未額滿'}`);
    } catch (e) {
      console.error(`[${item.id}] SSR失敗:`, e.message);
    }
  }

  async function scanEpkaw(item) {
    try {
      const html = await fetchPage(item.url);
      if (!html || html.length < 200) return;
      const text = stripHtml(html);
      const pageTitle = extractTitle(html);
      const title = item.label || pageTitle || `悠遊付活動(epkaw)`;

      const hasCapMechanism = /額滿即止|名額有限|名額已滿|額滿/.test(text);
      if (!hasCapMechanism) return;

      const full = detectFull(text, year, monthNum, month);
      ecardResults[item.id] = { full, title: title.substring(0, 50) };
      console.log(`[epkaw] ${title.substring(0, 40)} → ${full ? '額滿' : '未額滿'}`);
    } catch (e) {
      console.error(`[${item.id}] epkaw 失敗:`, e.message);
    }
  }

  const spaToScan = spaItems.filter(i => i.special || i.source === 'hardcoded');
  console.log(`SPA 需掃描: ${spaToScan.length} 個(跳過 ${spaItems.length - spaToScan.length} 個無額滿機制的 easywallet 活動)`);

  async function scanSpa(item) {
    try {
      const spa = await fetchSpaPage(browser, item.url);
      const text = spa.text;
      const pageTitle = spa.title.replace(/-悠遊卡股份有限公司/, '').replace(/悠遊付｜.*/, '').trim();
      const title = item.label || pageTitle || `悠遊付活動 ${item.id}`;

      if (item.special === 'challenge') {
        // 月級挑戰:三道防線
        // 1. 硬 regex(舊邏輯,格式固定時最精準)
        // 2. 寬鬆:級別關鍵字 + 額滿 + 當月 M/D
        // 3. PDF(在主流程已取得 pdfChallenge)
        const levels = [
          { suffix: 'silver', label: '銀級', hardRx: new RegExp(monthNum + '月銀級回饋已於[\\s\\S]*?額滿'), keywordRx: /銀級/ },
          { suffix: 'gold', label: '金級', hardRx: new RegExp(monthNum + '月金級回饋已於[\\s\\S]*?額滿'), keywordRx: /金級/ },
          { suffix: 'platinum', label: '白金級', hardRx: new RegExp(monthNum + '月白金回饋已於[\\s\\S]*?額滿'), keywordRx: /白金/ },
        ];

        const mm = monthNum.padStart(2, '0');
        const mdRx = new RegExp(`(?:^|[^0-9/])(${monthNum}|${mm})\\s*[/月]\\s*\\d{1,2}`);

        for (const lv of levels) {
          let full = false;
          let source = '';

          // 防線 1:硬 regex
          if (lv.hardRx.test(text)) {
            full = true;
            source = 'hard-regex';
          }

          // 防線 2:級別+額滿+本月共現
          if (!full) {
            const fullRx = /額滿/g;
            let m;
            while ((m = fullRx.exec(text)) !== null) {
              const start = Math.max(0, m.index - 150);
              const end = Math.min(text.length, m.index + 30);
              const ctx = text.substring(start, end);
              if (lv.keywordRx.test(ctx) && mdRx.test(ctx)) {
                full = true;
                source = 'keyword-context';
                break;
              }
            }
          }

          // 防線 3:PDF
          if (!full && pdfChallenge[lv.suffix] && pdfChallenge[lv.suffix].full) {
            full = true;
            source = 'pdf';
          }

          ecardResults[`challenge_${lv.suffix}`] = { full, title: `月級挑戰 ${lv.label}` };
          console.log(`[月級挑戰] ${lv.label} → ${full ? '額滿' : '未額滿'}${source ? ` (${source})` : ''}`);
        }
        return;
      }

      const full = detectFull(text, year, monthNum, month);
      ecardResults[item.id] = { full, title: title.substring(0, 50) };
      console.log(`[SPA] ${title.substring(0, 40)} → ${full ? '額滿' : '未額滿'}`);
    } catch (e) {
      console.error(`[${item.id}] SPA失敗:`, e.message);
    }
  }

  async function runPool(items, fn, concurrency) {
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        await fn(items[i]);
      }
    });
    await Promise.all(workers);
  }

  await Promise.all([
    runPool(ssrItems, scanSsr, 10),
    runPool(spaToScan, scanSpa, 3),
    runPool(epkawItems, scanEpkaw, 8),
  ]);

  await browser.close();

  // 如果 spaToScan 沒有 challenge(例如列表頁沒抓到、hardcoded 沒進去)
  // 但 PDF 有資料,仍然要寫入 ecardResults
  if (!ecardResults.challenge_silver && pdfChallenge.silver && pdfChallenge.silver.full) {
    ecardResults.challenge_silver = { full: true, title: '月級挑戰 銀級' };
    console.log('[月級挑戰] 銀級 → 額滿 (pdf, spaToScan 未包含 challenge)');
  }
  if (!ecardResults.challenge_gold && pdfChallenge.gold && pdfChallenge.gold.full) {
    ecardResults.challenge_gold = { full: true, title: '月級挑戰 金級' };
    console.log('[月級挑戰] 金級 → 額滿 (pdf, spaToScan 未包含 challenge)');
  }
  if (!ecardResults.challenge_platinum && pdfChallenge.platinum && pdfChallenge.platinum.full) {
    ecardResults.challenge_platinum = { full: true, title: '月級挑戰 白金級' };
    console.log('[月級挑戰] 白金級 → 額滿 (pdf, spaToScan 未包含 challenge)');
  }

  const tC4 = Date.now();
  console.log(`[計時] C 逐頁掃描: ${((tC4 - tC123) / 1000).toFixed(1)}s`);

  for (const [id, result] of Object.entries(ecardResults)) {
    if (!result.full) continue;
    promos.push({
      id: `easycard_${id}`,
      full: true,
      title: `${result.title}已額滿`,
      body: `${result.title} ${monthNum}月名額已滿`,
      category: '悠遊付'
    });
  }

  // ========== 活動倒數提醒 ==========
  const reminders = [
    { id: 'cube_japan', title: 'CUBE 日本賞', endDate: '2026-04-30' },
    { id: 'esun_pxpay', title: '玉山全支付綁卡3%', endDate: '2026-06-28' },
    { id: 'easycard_challenge', title: '悠遊付月級挑戰', endDate: '2026-04-01' },
    { id: 'easycard_bus10', title: '悠遊付乘車碼10%', endDate: '2026-03-31' },
    { id: 'pxpay_japan', title: '全支付日本PayPay回饋', endDate: '2026-03-29' },
    { id: 'icashpay_3c', title: 'icash Pay 網購3C 10%', endDate: '2026-06-30' },
    { id: 'ubot_ipassmoney', title: '聯邦iPASS MONEY 10%綠點', endDate: '2026-06-30' },
  ];

  // ========== 寫入狀態 ==========

  const newStatus = {
    uniopen_icash_full: icashFull, uniopen_icash_msg: icashMsg,
    starbucks_5_full: starbucksFull, starbucks_5_msg: starbucksMsg,
    sunday_7_full: sundayFull, sunday_7_msg: sundayMsg,
    uniopen_autoload_full: autoloadFull, uniopen_autoload_msg: autoloadMsg,
    transport_10: transport,
    online3c_10: online3c,
    ubot_ipassmoney: ubotIpass,
    easycard_results: ecardResults,
    promos: promos,
    reminders: reminders,
    updated: todayStr
  };

  const changed = JSON.stringify(currentStatus, null, 2) !== JSON.stringify(newStatus, null, 2);
  fs.writeFileSync(STATUS_FILE, JSON.stringify(newStatus, null, 2) + '\n');

  console.log(`\n===== 總結 =====`);
  console.log(`額滿活動: ${promos.length} 項`);
  for (const p of promos) console.log(`  [${p.category}] ${p.title}`);

  console.log('\n--- 悠遊付活動標題 ---');
  for (const [id, result] of Object.entries(ecardResults)) {
    console.log(`  ${id}: ${result.title} ${result.full ? '[額滿]' : ''}`);
  }

  console.log(changed ? 'STATUS_CHANGED=true' : 'STATUS_CHANGED=false');
  console.log(`[計時] 總耗時: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

checkPromo().catch(err => { console.error('執行失敗:', err); process.exit(1); });
