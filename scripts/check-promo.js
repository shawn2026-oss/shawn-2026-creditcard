/**
 * 自動檢查活動額滿狀態（puppeteer 版 v2）
 * GitHub Actions 每天台灣時間 10/14/18/22 點執行
 *
 * A. icash Pay (icashpay.com.tw) — fetchPage
 * B. icash2.0 (icash.com.tw) — fetchPageWithCookie
 * C. 悠遊付 — 三層掃描：
 *    C1. easycard.com.tw/offers 列表頁（puppeteer 翻頁掃全頁）
 *    C2. easywallet.easycard.com.tw/benefit 列表頁（puppeteer）
 *    C3. hardcoded 保底清單（不在列表頁但已知重要的活動）
 *    C4. 逐頁 fetchPage 偵測額滿
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

// ===== 額滿偵測（通用） =====

function detectFull(text, year, monthNum, month) {
  const patterns = [
    new RegExp(monthNum + '月[\\s\\S]{0,200}?額滿'),
    new RegExp('已於\\s*' + year + '/' + monthNum + '/[\\s\\S]{0,50}?額滿'),
    new RegExp('已於\\s*' + year + '/' + month + '/[\\s\\S]{0,50}?額滿'),
    new RegExp('已於\\s*' + year + '年' + monthNum + '月[\\s\\S]{0,50}?額滿'),
    // 「本活動一 已於2026/3/13 17:31:32 額滿」格式
    new RegExp('已於\\s*' + year + '/' + month + '/\\d+[\\s\\S]{0,30}?額滿'),
  ];
  for (const p of patterns) {
    if (text.match(p)) return true;
  }
  return false;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (!m) return '';
  return m[1]
    .replace(/-悠遊卡股份有限公司/, '')
    .replace(/悠遊付｜.*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ===== 悠遊付：三層掃描收集 URL =====

async function collectEasycardOfferUrls(browser) {
  const seen = new Set();
  const results = []; // { id, url, source }

  function addUrl(id, url, source) {
    if (!seen.has(id)) {
      seen.add(id);
      results.push({ id, url, source });
    }
  }

  // --- C1: easycard.com.tw/offers 列表頁（含翻頁）---
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    // 不帶分類參數，抓全部活動
    const listUrl = 'https://www.easycard.com.tw/offers';
    console.log('[C1] 載入 easycard.com.tw/offers 列表頁...');
    await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // 掃描多頁（最多 15 頁，避免無限迴圈）
    for (let pageNum = 1; pageNum <= 15; pageNum++) {
      // 捲動觸發 lazy load
      await page.evaluate(async () => {
        for (let i = 0; i < 8; i++) {
          window.scrollBy(0, 600);
          await new Promise(r => setTimeout(r, 300));
        }
      });
      await new Promise(r => setTimeout(r, 1500));

      // 提取此頁所有活動連結
      const links = await page.$$eval('a[href*="offer"]', as =>
        as.map(a => a.href).filter(h =>
          h.includes('id=') &&
          (h.includes('easycard.com.tw/offer') || h.includes('easywallet.easycard.com.tw'))
        )
      );

      let newCount = 0;
      for (const link of links) {
        const idMatch = link.match(/id=(\d+)/);
        if (idMatch) {
          const before = seen.size;
          addUrl(idMatch[1], link, 'easycard_list');
          if (seen.size > before) newCount++;
        }
      }
      console.log(`[C1] 第 ${pageNum} 頁: 找到 ${links.length} 個連結，新增 ${newCount} 個`);

      // 嘗試點下一頁
      const hasNext = await page.evaluate((currentPage) => {
        // 找頁碼區域的連結
        const pageLinks = document.querySelectorAll('.pagination a, .page-link, .pager a, a[href*="page="]');
        for (const a of pageLinks) {
          const text = a.textContent.trim();
          const href = a.getAttribute('href') || '';
          // 找到「下一頁」或下一個頁碼數字
          if (text === String(currentPage + 1) || text === '下一頁' || text === '>' || text === '»') {
            a.click();
            return true;
          }
        }
        // 也嘗試用 page= 參數的連結
        const nextPageLink = document.querySelector(`a[href*="page=${currentPage + 1}"]`);
        if (nextPageLink) {
          nextPageLink.click();
          return true;
        }
        return false;
      }, pageNum);

      if (!hasNext) {
        console.log(`[C1] 無下一頁，共掃描 ${pageNum} 頁`);
        break;
      }

      // 等待頁面載入
      await new Promise(r => setTimeout(r, 3000));
      await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
    }

    await page.close();
  } catch (e) {
    console.error('[C1] easycard.com.tw 列表頁掃描失敗:', e.message);
  }

  // --- C2: easywallet.easycard.com.tw/benefit 列表頁 ---
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    console.log('[C2] 載入 easywallet 好康優惠列表頁...');
    await page.goto('https://easywallet.easycard.com.tw/benefit', { waitUntil: 'networkidle2', timeout: 30000 });

    // easywallet 是 SPA，捲動載入更多
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 2000));

    // 提取所有活動連結
    const links = await page.$$eval('a[href*="benefit/content"]', as =>
      as.map(a => a.href).filter(h => h.includes('id='))
    );

    for (const link of links) {
      const idMatch = link.match(/id=(\d+)/);
      if (idMatch) {
        addUrl('ew_' + idMatch[1], link, 'easywallet_list');
      }
    }
    console.log(`[C2] easywallet 列表頁找到 ${links.length} 個連結`);

    await page.close();
  } catch (e) {
    console.error('[C2] easywallet 列表頁掃描失敗:', e.message);
  }

  // --- C3: hardcoded 保底清單 ---
  // 這些是已知重要但可能不在列表頁的活動 URL
  // 每季或活動更新時手動維護
  const KNOWN_URLS = [
    // 月級挑戰（三等級額滿分開偵測）
    { id: 'challenge_1766109563', url: 'https://easywallet.easycard.com.tw/benefit/content?id=1766109563', label: '月級挑戰', special: 'challenge' },
    // 乘車碼10%回饋
    { id: 'ew_1771988018', url: 'https://www.easycard.com.tw/offer?id=1771988018', label: '乘車碼10%回饋' },
    // 新會員3%回饋
    { id: 'ew_1766377676', url: 'https://easywallet.easycard.com.tw/benefit/content?id=1766377676', label: '新會員3%回饋' },
    // 推薦好友送$100
    { id: 'ew_1766573956', url: 'https://www.easycard.com.tw/offer?id=1766573956', label: '推薦好友送$100' },
    // 週五會員日（如果有獨立頁面的話，暫留佔位）
    // { id: 'friday_xxx', url: '...', label: '週五會員日' },
  ];

  for (const item of KNOWN_URLS) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      results.push({ id: item.id, url: item.url, source: 'hardcoded', label: item.label, special: item.special });
    }
  }
  console.log(`[C3] hardcoded 保底: 補充 ${KNOWN_URLS.filter(u => results.find(r => r.id === u.id && r.source === 'hardcoded')).length} 個`);

  console.log(`\n[悠遊付] 總計收集 ${results.length} 個活動 URL`);
  return results;
}

// ===== 主程式 =====

async function checkPromo() {
  const { year, month, monthNum, todayStr } = getMonthStr();
  let currentStatus = {};
  try { currentStatus = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch (e) { console.log('無現有狀態檔'); }

  const lastMonth = (currentStatus.updated || '').substring(0, 7);
  const thisMonth = todayStr.substring(0, 7);
  const needReset = thisMonth !== lastMonth && new Date().getDate() <= 3;
  function prev(key) { return needReset ? false : (currentStatus[key] || false); }

  const promos = [];

  // ========== A. icash Pay ==========

  // 1. id/2019 — 4%全通路 + 星巴克5%
  let icashFull = prev('uniopen_icash_full'), icashMsg = needReset ? '' : (currentStatus.uniopen_icash_msg || '');
  let starbucksFull = prev('starbucks_5_full'), starbucksMsg = needReset ? '' : (currentStatus.starbucks_5_msg || '');
  try {
    const p = await fetchPage('https://www.icashpay.com.tw/advertMessage/view/id/2019');
    const ms = p.match(new RegExp(year + '年' + monthNum + '月[\\s\\S]*?額滿', 'g'));
    if (ms) for (const m of ms) {
      if (m.includes('筆筆回饋5%') || m.includes('筆筆饋5%')) { starbucksFull = true; starbucksMsg = `${year}年${monthNum}月 星巴克筆筆5%已額滿`; console.log('[id/2019] 星巴克5%額滿'); }
      else if (m.includes('全通路') || m.includes('不限金額')) { icashFull = true; icashMsg = `${year}年${monthNum}月 icash Pay 4%已額滿`; console.log('[id/2019] icash Pay 4%額滿'); }
    }
    if (!icashFull) console.log('[id/2019] icash Pay 4% 未額滿');
    if (!starbucksFull) console.log('[id/2019] 星巴克5% 未額滿');
  } catch (e) { console.error('[id/2019] 失敗:', e.message); }

  if (icashFull) promos.push({ id: 'icash_4', full: true, title: 'icash Pay 4%已額滿', body: `icash Pay 全通路4% ${monthNum}月名額已滿`, category: 'icash Pay' });
  else promos.push({ id: 'icash_4', full: false, title: 'icash Pay 4%全通路', body: '', category: 'icash Pay' });
  if (starbucksFull) promos.push({ id: 'starbucks_5', full: true, title: '星巴克5%已額滿', body: `icash Pay 星巴克5% ${monthNum}月名額已滿`, category: 'icash Pay' });
  else promos.push({ id: 'starbucks_5', full: false, title: '星巴克5%', body: '', category: 'icash Pay' });

  // 2. id/2037 — 交通10%
  const banks = ['台新', '兆豐', '一銀', '華南', '元大'];
  let transport = currentStatus.transport_10 || {};
  if (needReset) { transport = {}; for (const b of banks) transport[b] = { full: false, msg: '' }; }
  else { for (const b of banks) if (!transport[b]) transport[b] = { full: false, msg: '' }; }
  try {
    const p = await fetchPage('https://www.icashpay.com.tw/advertMessage/view/id/2037');
    for (const b of banks) {
      const m = p.match(new RegExp(b + monthNum.padStart(2, '0') + '月份贈點已於[\\s\\S]*?額滿'));
      if (m) { transport[b].full = true; transport[b].msg = m[0].replace(/&nbsp;/g, ' ').trim(); console.log(`[id/2037] ${b} 額滿`); }
      else console.log(`[id/2037] ${b} 未額滿`);
    }
  } catch (e) { console.error('[id/2037] 失敗:', e.message); }
  for (const b of banks) {
    if (transport[b].full) promos.push({ id: `transport_${b}`, full: true, title: `交通10%額滿(${b})`, body: `icash Pay 交通10% ${b} ${monthNum}月名額已滿`, category: 'icash Pay' });
    else promos.push({ id: `transport_${b}`, full: false, title: `交通10% ${b}`, body: '', category: 'icash Pay' });
  }

  // 3. id/1954 — 週日7%
  let sundayFull = prev('sunday_7_full'), sundayMsg = needReset ? '' : (currentStatus.sunday_7_msg || '');
  try {
    const p = await fetchPage('https://www.icashpay.com.tw/advertMessage/view/id/1954');
    if (p.match(new RegExp(year + '年' + monthNum + '月[\\s\\S]*?週日[\\s\\S]*?額滿'))) { sundayFull = true; sundayMsg = `${year}年${monthNum}月 週日7%已額滿`; console.log('[id/1954] 週日7%額滿'); }
    else console.log('[id/1954] 週日7% 未額滿');
  } catch (e) { console.error('[id/1954] 失敗:', e.message); }
  if (sundayFull) promos.push({ id: 'sunday_7', full: true, title: '週日7%已額滿', body: `icash Pay 週日7% ${monthNum}月名額已滿`, category: 'icash Pay' });
  else promos.push({ id: 'sunday_7', full: false, title: '週日全通路7%', body: '', category: 'icash Pay' });

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
  else promos.push({ id: 'uniopen_autoload', full: false, title: 'uniopen自動加值10%', body: '', category: 'icash2.0' });

  // ========== C. 悠遊付（三層掃描）==========

  console.log('\n===== 悠遊付三層掃描 =====');

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

  await browser.close();

  // --- C4: 逐頁掃描額滿 ---
  console.log('\n===== 悠遊付逐頁掃描額滿 =====');
  const ecardResults = {};

  for (const item of offerUrls) {
    try {
      const html = await fetchPage(item.url);
      const text = html.replace(/<[^>]+>/g, ' ');
      const title = item.label || extractTitle(html) || `活動 ${item.id}`;

      // 月級挑戰特殊處理：三個等級
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
        continue;
      }

      const full = detectFull(text, year, monthNum, month);
      ecardResults[item.id] = { full, title: title.substring(0, 50) };
      console.log(`[${item.source}] ${title.substring(0, 40)} → ${full ? '額滿' : '未額滿'}`);
    } catch (e) {
      console.error(`[${item.id}] 失敗:`, e.message);
    }
  }

  // 把所有悠遊付活動加入 promos
  for (const [id, result] of Object.entries(ecardResults)) {
    promos.push({
      id: `easycard_${id}`,
      full: result.full,
      title: result.full ? `${result.title}已額滿` : result.title,
      body: result.full ? `${result.title} ${monthNum}月名額已滿` : '',
      category: '悠遊付'
    });
  }

  // ========== 寫入狀態 ==========

  const newStatus = {
    uniopen_icash_full: icashFull, uniopen_icash_msg: icashMsg,
    starbucks_5_full: starbucksFull, starbucks_5_msg: starbucksMsg,
    sunday_7_full: sundayFull, sunday_7_msg: sundayMsg,
    uniopen_autoload_full: autoloadFull, uniopen_autoload_msg: autoloadMsg,
    transport_10: transport,
    easycard_results: ecardResults,
    promos: promos,
    updated: todayStr
  };

  const changed = JSON.stringify(currentStatus, null, 2) !== JSON.stringify(newStatus, null, 2);
  fs.writeFileSync(STATUS_FILE, JSON.stringify(newStatus, null, 2) + '\n');

  console.log(`\n===== 總結 =====`);
  console.log(`總活動: ${promos.length} 項，額滿: ${promos.filter(p => p.full).length} 項`);
  for (const p of promos.filter(p => p.full)) console.log(`  [${p.category}] ${p.title}`);
  console.log(changed ? 'STATUS_CHANGED=true' : 'STATUS_CHANGED=false');
}

checkPromo().catch(err => { console.error('執行失敗:', err); process.exit(1); });
