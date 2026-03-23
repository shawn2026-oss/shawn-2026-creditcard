/**
 * 自動檢查活動額滿狀態（puppeteer 版）
 * GitHub Actions 每天台灣時間 10/14/18/22 點執行
 *
 * A. icash Pay (icashpay.com.tw) — fetchPage
 * B. icash2.0 (icash.com.tw) — fetchPageWithCookie
 * C. 悠遊付 (easycard.com.tw + easywallet) — puppeteer 掃列表 + fetchPage 掃內頁
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
      // Follow redirects
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
  // 多種額滿格式
  const patterns = [
    new RegExp(monthNum + '月[\\s\\S]{0,200}?額滿'),
    new RegExp('已於\\s*' + year + '/' + monthNum + '/[\\s\\S]{0,50}?額滿'),
    new RegExp('已於\\s*' + year + '/' + month + '/[\\s\\S]{0,50}?額滿'),
  ];
  for (const p of patterns) {
    if (text.match(p)) return true;
  }
  return false;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (!m) return '';
  return m[1].replace(/-悠遊卡股份有限公司/, '').replace(/悠遊付｜.*/, '').trim();
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

  // ========== C. 悠遊付（動態掃描）==========

  console.log('\n===== 悠遊付動態掃描 =====');

  // C1: 用 puppeteer 從列表頁取得所有活動 URL
  let offerUrls = [];
  try {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    // 載入好康特區（全分類）
    const listUrl = 'https://www.easycard.com.tw/offers?cls=1506473490,1506473503,1508721809,1508721884,1506473519';
    console.log('[puppeteer] 載入列表頁...');
    await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // 捲動觸發 lazy load
    await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) {
        window.scrollBy(0, 800);
        await new Promise(r => setTimeout(r, 500));
      }
    });
    await new Promise(r => setTimeout(r, 2000));

    // 提取所有活動連結（/offer? 包含 id=）
    const links = await page.$$eval('a[href*="offer"]', as =>
      as.map(a => a.href).filter(h => h.includes('id=') && h.includes('easycard.com.tw'))
    );

    // 去重（以 id 為 key）
    const seen = new Set();
    for (const link of links) {
      const idMatch = link.match(/id=(\d+)/);
      if (idMatch && !seen.has(idMatch[1])) {
        seen.add(idMatch[1]);
        offerUrls.push({ id: idMatch[1], url: link });
      }
    }

    console.log(`[puppeteer] 找到 ${offerUrls.length} 個活動頁面`);
    await browser.close();
  } catch (e) {
    console.error('[puppeteer] 列表頁抓取失敗:', e.message);
    console.log('[puppeteer] 跳過動態掃描');
  }

  // C2: 加入 easywallet 月級挑戰（不在 easycard.com.tw 列表裡）
  const extraUrls = [
    { id: 'challenge_1766109563', url: 'https://easywallet.easycard.com.tw/benefit/content?id=1766109563', label: '月級挑戰' },
  ];

  // C3: 逐頁掃描額滿
  const ecardResults = {}; // id → { full, title }

  // 掃 easycard.com.tw 活動頁（server-rendered，用 fetchPage）
  for (const item of offerUrls) {
    try {
      const html = await fetchPage(item.url);
      const text = html.replace(/<[^>]+>/g, ' ');
      const title = extractTitle(html);
      const full = detectFull(text, year, monthNum, month);
      ecardResults[item.id] = { full, title };
      console.log(`[easycard id=${item.id}] ${title.substring(0, 30)} → ${full ? '額滿' : '未額滿'}`);
    } catch (e) {
      console.error(`[easycard id=${item.id}] 失敗:`, e.message);
    }
  }

  // 掃 easywallet 額外頁面
  for (const item of extraUrls) {
    try {
      const html = await fetchPage(item.url);
      const text = html.replace(/<[^>]+>/g, ' ');

      // 月級挑戰特殊處理：三個等級
      if (item.label === '月級挑戰') {
        const levels = [
          { suffix: 'silver', label: '銀級', rx: new RegExp(monthNum + '月銀級回饋已於[\\s\\S]*?額滿') },
          { suffix: 'gold', label: '金級', rx: new RegExp(monthNum + '月金級回饋已於[\\s\\S]*?額滿') },
          { suffix: 'platinum', label: '白金級', rx: new RegExp(monthNum + '月白金回饋已於[\\s\\S]*?額滿') },
        ];
        for (const lv of levels) {
          const full = !!text.match(lv.rx);
          ecardResults[`challenge_${lv.suffix}`] = { full, title: `月級挑戰 ${lv.label}` };
          console.log(`[easywallet] 月級挑戰${lv.label} → ${full ? '額滿' : '未額滿'}`);
        }
      } else {
        const title = extractTitle(html) || item.label;
        const full = detectFull(text, year, monthNum, month);
        ecardResults[item.id] = { full, title };
        console.log(`[easywallet] ${title.substring(0, 30)} → ${full ? '額滿' : '未額滿'}`);
      }
    } catch (e) {
      console.error(`[easywallet ${item.label}] 失敗:`, e.message);
    }
  }

  // 把所有悠遊付活動加入 promos（含未額滿）
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

  console.log(`\n總活動: ${promos.length} 項，額滿: ${promos.filter(p => p.full).length} 項`);
  for (const p of promos.filter(p => p.full)) console.log(`  [${p.category}] ${p.title}`);
  console.log(changed ? 'STATUS_CHANGED=true' : 'STATUS_CHANGED=false');
}

checkPromo().catch(err => { console.error('執行失敗:', err); process.exit(1); });
