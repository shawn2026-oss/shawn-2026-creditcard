/**
 * 自動檢查活動額滿狀態(puppeteer 版 v2.2)
 * GitHub Actions 每天台灣時間 00/08/14/20 點執行
 *
 * v2.2 修正:
 *   - icash Pay 改用「列表頁自動發現 + 標題關鍵字分類」,避免 icash Pay
 *     換頁(id/2019 → id/1982)時爬蟲完全失效
 *   - 每個子活動類別(uniopen 4% / 星巴克 / 交通 / 3C / 週日)對到多個候選頁面,
 *     任一頁抓到本月額滿就算額滿
 *   - 保留原本四個 hardcoded id 作為 fallback
 *
 * v2.1 修正:
 *   - id/2019 icash Pay 4% / 星巴克 5% 改用「額滿上下文 + 共現」判定
 *   - online3c_10 / transport_10 的 msg 欄位先脫 HTML tag 再存
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const puppeteer = require('puppeteer');

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

// ===== 額滿偵測(通用,供悠遊付用) =====

function detectFull(text, year, monthNum, month) {
  const patterns = [
    new RegExp(monthNum + '月[\\s\\S]{0,200}?額滿'),
    new RegExp('已於\\s*' + year + '/' + monthNum + '/[\\s\\S]{0,50}?額滿'),
    new RegExp('已於\\s*' + year + '/' + month + '/[\\s\\S]{0,50}?額滿'),
    new RegExp('已於\\s*' + year + '年' + monthNum + '月[\\s\\S]{0,50}?額滿'),
    new RegExp('已於\\s*' + year + '/' + month + '/\\d+[\\s\\S]{0,30}?額滿'),
  ];
  for (const p of patterns) {
    if (text.match(p)) return true;
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

// ===== icash Pay 列表頁自動發現 =====

/**
 * 爬 advertMessage/index 1~5 頁,把所有活動按標題關鍵字分到 5 個 bucket。
 * 呼叫端對每個 bucket 內所有頁面都掃一次,任一頁額滿就算額滿。
 */
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

    // 抓所有 advertMessage/view/id/\d+ 連結 + <a> 內的文字作為標題
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

      // 標題太短(只有 img),往後抓 400 字當 context
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

      // === 標題關鍵字分類(注意順序:具體優先)===
      let classified = false;

      // 星巴克 5%
      if (/星巴克|starbucks/i.test(title) && /5\s*%|筆筆/.test(title)) {
        buckets.starbucks_5pct.push(entry);
        classified = true;
      }

      // 網購 3C 10%
      if (/(網購|3\s*C|數位|電商)/.test(title) && /10\s*%/.test(title)) {
        buckets.online3c_10pct.push(entry);
        classified = true;
      }

      // 交通 10%
      if (/(交通|捷運|公車|大眾運輸|YouBike|iPASS|悠遊)/.test(title) && /10\s*%/.test(title)) {
        buckets.transport_10pct.push(entry);
        classified = true;
      }

      // 週日 7%
      if (/週日|星期日|日曜/.test(title) && /7\s*%/.test(title)) {
        buckets.sunday_7pct.push(entry);
        classified = true;
      }

      // UNIOPEN 4% 全通路(最寬,最後判斷)
      // 標題範例:「icash Pay超強支付 綁uniopen聯名卡天天最高11%」「全通路4%」
      if (!classified && /uniopen|UNIOPEN|全通路|天天最高|天天回饋/i.test(title)) {
        buckets.uniopen_4pct.push(entry);
        classified = true;
      }

      if (classified) foundInPage++;
    }
    console.log(`[icash Pay 列表] page ${pageNum}: 分類到 ${foundInPage} 個活動`);
  }

  // === Fallback:保底加入原本 hardcoded 的 id,防列表頁抓不到 ===
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

/**
 * 掃描某個 bucket 裡的所有頁面,任一頁抓到本月額滿就回 {full:true,...}
 * subMatch: context 必須含這個 pattern 才算
 * excludeSubMatch: context 含這個 pattern 就跳過
 */
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

// ===== 悠遊付:三層掃描收集 URL + 標題 =====

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

  // ========== A. icash Pay(列表頁自動發現)==========

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

  // --- A2. 星巴克筆筆 5% ---
  let starbucksFull = prev('starbucks_5_full'), starbucksMsg = needReset ? '' : (currentStatus.starbucks_5_msg || '');
  try {
    // 星巴克可能在專屬頁面或跟 uniopen 4% 共頁,兩個 bucket 合併掃
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

  // --- A3. 交通 10%(多銀行)---
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

  // --- A5. 網購 3C 10%(多銀行)---
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

  // ========== C. 悠遊付(三層掃描)==========

  const tAB = Date.now();
  console.log(`\n[計時] A+B: ${((tAB - startTime) / 1000).toFixed(1)}s`);
  console.log('===== 悠遊付三層掃描 =====');

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
  console.log(`[計時] C1+C2+C3 URL收集: ${((tC123 - tAB) / 1000).toFixed(1)}s`);

  console.log('\n===== 悠遊付逐頁掃描額滿 =====');
  const ecardResults = {};

  const spaItems = offerUrls.filter(i => i.url.includes('easywallet.easycard.com.tw'));
  const ssrItems = offerUrls.filter(i => !i.url.includes('easywallet.easycard.com.tw'));

  console.log(`SSR: ${ssrItems.length} 個, SPA: ${spaItems.length} 個`);

  async function scanSsr(item) {
    try {
      const html = await fetchPage(item.url);
      const text = html.replace(/<[^>]+>/g, ' ');
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

  const spaToScan = spaItems.filter(i => i.special || i.source === 'hardcoded');
  console.log(`SPA 需掃描: ${spaToScan.length} 個(跳過 ${spaItems.length - spaToScan.length} 個無額滿機制的 easywallet 活動)`);

  async function scanSpa(item) {
    try {
      const spa = await fetchSpaPage(browser, item.url);
      const text = spa.text;
      const pageTitle = spa.title.replace(/-悠遊卡股份有限公司/, '').replace(/悠遊付｜.*/, '').trim();
      const title = item.label || pageTitle || `悠遊付活動 ${item.id}`;

      if (item.special === 'challenge') {
        const levels = [
          { suffix: 'silver', label: '銀級', rx: new RegExp(monthNum + '月銀級回饋已於[\\s\\S]*?額滿') },
          { suffix: 'gold', label: '金級', rx: new RegExp(monthNum + '月金級回饋已於[\\s\\S]*?額滿') },
          { suffix: 'platinum', label: '白金級', rx: new RegExp(monthNum + '月白金回饋已於[\\s\\S]*?額滿') },
        ];
        for (const lv of levels) {
          const full = !!text.match(lv.rx);
          ecardResults[`challenge_${lv.suffix}`] = { full, title: `月級挑戰 ${lv.label}` };
          console.log(`[月級挑戰] ${lv.label} → ${full ? '額滿' : '未額滿'}`);
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
  ]);

  await browser.close();

  const tC4 = Date.now();
  console.log(`[計時] C4 逐頁掃描: ${((tC4 - tC123) / 1000).toFixed(1)}s`);

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

  // ========== 活動倒數提醒(手動維護)==========
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
