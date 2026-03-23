/**
 * 自動檢查活動額滿狀態
 * GitHub Actions 每天台灣時間 10/14/18/22 點執行
 *
 * A. icash Pay (icashpay.com.tw): 4%全通路+星巴克5%, 交通10%, 週日7%
 * B. icash2.0 (icash.com.tw): uniopen自動加值10%
 * C. 悠遊付 (easycard.com.tw): 週五元大/乘車碼/日常美食/早餐速食/週末聚餐/月級挑戰/7-ELEVEN/全家/新會員
 */

const https = require('https');
const http = require('http');
const fs = require('fs');

const STATUS_FILE = 'promo_status.json';

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { resolve(''); }, 15000);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { clearTimeout(timer); resolve(data); });
    }).on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function fetchPageWithCookie(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { console.log('[fetchPageWithCookie] 超時 10 秒'); resolve(''); }, 10000);
    let redirectCount = 0;
    let allCookies = '';
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

async function checkPromo() {
  const { year, month, monthNum, todayStr } = getMonthStr();
  let currentStatus = {};
  try { currentStatus = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch (e) { console.log('無現有狀態檔'); }

  const lastMonth = (currentStatus.updated || '').substring(0, 7);
  const thisMonth = todayStr.substring(0, 7);
  const needReset = thisMonth !== lastMonth && new Date().getDate() <= 3;

  function prev(key) { return needReset ? false : (currentStatus[key] || false); }

  // ===== A. icash Pay =====

  // 1. id/2019 — 4%全通路 + 星巴克5%
  let icashFull = prev('uniopen_icash_full'), icashMsg = needReset ? '' : (currentStatus.uniopen_icash_msg || '');
  let starbucksFull = prev('starbucks_5_full'), starbucksMsg = needReset ? '' : (currentStatus.starbucks_5_msg || '');
  try {
    const p = await fetchPage('https://www.icashpay.com.tw/advertMessage/view/id/2019');
    const ms = p.match(new RegExp(year + '年' + monthNum + '月[\\s\\S]*?額滿', 'g'));
    if (ms) for (const m of ms) {
      if (m.includes('筆筆回饋5%') || m.includes('筆筆饋5%')) { starbucksFull = true; starbucksMsg = `${year}年${monthNum}月 星巴克筆筆5%已額滿`; console.log(`[id/2019] 星巴克5%額滿`); }
      else if (m.includes('全通路') || m.includes('不限金額')) { icashFull = true; icashMsg = `${year}年${monthNum}月 icash Pay 4%已額滿`; console.log(`[id/2019] icash Pay 4%額滿`); }
    }
    if (!icashFull) console.log('[id/2019] icash Pay 4% 未額滿');
    if (!starbucksFull) console.log('[id/2019] 星巴克5% 未額滿');
  } catch (e) { console.error('[id/2019] 失敗:', e.message); }

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

  // 3. id/1954 — 週日7%
  let sundayFull = prev('sunday_7_full'), sundayMsg = needReset ? '' : (currentStatus.sunday_7_msg || '');
  try {
    const p = await fetchPage('https://www.icashpay.com.tw/advertMessage/view/id/1954');
    if (p.match(new RegExp(year + '年' + monthNum + '月[\\s\\S]*?週日[\\s\\S]*?額滿'))) { sundayFull = true; sundayMsg = `${year}年${monthNum}月 週日7%已額滿`; console.log('[id/1954] 週日7%額滿'); }
    else console.log('[id/1954] 週日7% 未額滿');
  } catch (e) { console.error('[id/1954] 失敗:', e.message); }

  // ===== B. icash2.0 =====

  // 4. ID=12654 — uniopen自動加值10%
  let autoloadFull = prev('uniopen_autoload_full'), autoloadMsg = needReset ? '' : (currentStatus.uniopen_autoload_msg || '');
  try {
    const raw = await fetchPageWithCookie('https://www.icash.com.tw/Home/NewsDetail?ID=12654');
    const t = raw.replace(/<[^>]+>/g, '');
    if (t.length > 100 && t.match(new RegExp(monthNum + '月[\\s\\S]*?加值[\\s\\S]*?額滿'))) {
      autoloadFull = true; autoloadMsg = `${year}年${monthNum}月 uniopen自動加值10%已額滿`; console.log('[ID=12654] 額滿');
    } else console.log('[ID=12654] 未額滿或頁面過短');
  } catch (e) { console.error('[ID=12654] 失敗:', e.message); }

  // ===== C. 悠遊付 (easycard.com.tw) =====

  const ecActs = [
    { id: 'easycard_yuanta', label: '週五元大加碼', url: 'https://www.easycard.com.tw/offer?cls=1506473490%2C1506473503%2C1508721809%2C1508721884%2C&id=1747884970',
      rx: () => new RegExp('元大銀行每週五' + monthNum + '月份加碼已於[\\s\\S]*?額滿'),
      title: '悠遊付元大加碼已額滿', body: `悠遊付週五會員日 元大${monthNum}月份加碼名額已滿` },
    { id: 'easycard_ride', label: '乘車碼10%', url: 'https://www.easycard.com.tw/offer?cls=1508721884%2C1506473490%2C1506473503%2C&id=1771988018',
      rx: () => new RegExp('已於' + year + '/' + monthNum + '/[\\s\\S]*?額滿'),
      title: '悠遊付乘車碼10%已額滿', body: `悠遊付乘車碼10%回饋 ${monthNum}月名額已滿` },
    { id: 'easycard_food', label: '日常美食2%', url: 'https://www.easycard.com.tw/offer?cls=1506473503%2C1508721809%2C1506473490%2C&id=1765765539',
      rx: () => new RegExp('※\\s*' + monthNum + '月於[\\s\\S]*?額滿'),
      title: '悠遊付日常美食2%已額滿', body: `悠遊付日常美食2% ${monthNum}月名額已滿` },
    { id: 'easycard_breakfast', label: '早餐速食2%', url: 'https://www.easycard.com.tw/offer?cls=1506473503%2C1508721809%2C1506473490%2C&id=1765791389',
      rx: () => new RegExp('※\\s*' + monthNum + '月於[\\s\\S]*?額滿'),
      title: '悠遊付早餐速食2%已額滿', body: `悠遊付早餐速食2% ${monthNum}月名額已滿` },
    { id: 'easycard_weekend', label: '週末聚餐2%', url: 'https://www.easycard.com.tw/offer?cls=1506473503%2C1508721809%2C1506473490%2C&id=1765871049',
      rx: () => new RegExp('※\\s*' + monthNum + '月於[\\s\\S]*?額滿'),
      title: '悠遊付週末聚餐2%已額滿', body: `悠遊付週末聚餐2% ${monthNum}月名額已滿` },
    { id: 'easycard_seven', label: '7-ELEVEN贈券', url: 'https://www.easycard.com.tw/offer?cls=1506473490%2C1506473503%2C1508721809%2C&id=1766844961',
      rx: () => new RegExp(monthNum + '月份累計消費[\\s\\S]*?已額滿'),
      title: '悠遊付7-ELEVEN贈券已額滿', body: `悠遊付7-ELEVEN滿額贈券 ${monthNum}月名額已滿` },
    { id: 'easycard_family', label: '全家回饋', url: 'https://www.easycard.com.tw/offer?cls=1506473490%2C1506473503%2C1508721809%2C&id=1766475778',
      rx: () => new RegExp('※\\s*' + monthNum + '月[\\s\\S]*?額滿'),
      title: '悠遊付全家回饋已額滿', body: `悠遊付全家回饋 ${monthNum}月名額已滿` },
    { id: 'easycard_newmember', label: '新會員3%', url: 'https://www.easycard.com.tw/offer?cls=1506473490%2C1506473503%2C&id=1766377676',
      rx: () => new RegExp(monthNum + '月[\\s\\S]*?額滿'),
      title: '悠遊付新會員3%已額滿', body: `悠遊付新會員3% ${monthNum}月名額已滿` },
  ];

  let ecResults = {};
  for (const a of ecActs) ecResults[a.id] = prev(a.id + '_full');
  ecResults['easycard_challenge_silver'] = prev('easycard_challenge_silver_full');
  ecResults['easycard_challenge_gold'] = prev('easycard_challenge_gold_full');
  ecResults['easycard_challenge_platinum'] = prev('easycard_challenge_platinum_full');

  for (const a of ecActs) {
    try {
      const html = await fetchPage(a.url);
      const text = html.replace(/<[^>]+>/g, ' ');
      if (text.match(a.rx())) { ecResults[a.id] = true; console.log(`[easycard] ${a.label} 額滿`); }
      else console.log(`[easycard] ${a.label} 未額滿`);
    } catch (e) { console.error(`[easycard] ${a.label} 失敗:`, e.message); }
  }

  // 月級挑戰（銀/金/白金同一頁）— 格式：3月銀級回饋已於3/08 14:49:26額滿
  try {
    const html = await fetchPage('https://easywallet.easycard.com.tw/benefit/content?id=1766109563');
    const text = html.replace(/<[^>]+>/g, ' ');
    if (text.match(new RegExp(monthNum + '月銀級回饋已於[\\s\\S]*?額滿'))) { ecResults['easycard_challenge_silver'] = true; console.log('[easycard] 月級挑戰銀級額滿'); }
    else console.log('[easycard] 月級挑戰銀級 未額滿');
    if (text.match(new RegExp(monthNum + '月金級回饋已於[\\s\\S]*?額滿'))) { ecResults['easycard_challenge_gold'] = true; console.log('[easycard] 月級挑戰金級額滿'); }
    else console.log('[easycard] 月級挑戰金級 未額滿');
    if (text.match(new RegExp(monthNum + '月白金回饋已於[\\s\\S]*?額滿'))) { ecResults['easycard_challenge_platinum'] = true; console.log('[easycard] 月級挑戰白金級額滿'); }
    else console.log('[easycard] 月級挑戰白金級 未額滿');
  } catch (e) { console.error('[easycard] 月級挑戰失敗:', e.message); }

  // ===== 組合 promos =====
  const promos = [];
  if (icashFull) promos.push({ id: 'icash_4', full: true, title: 'icash Pay 4%已額滿', body: `icash Pay 全通路4% ${monthNum}月名額已滿` });
  if (starbucksFull) promos.push({ id: 'starbucks_5', full: true, title: '星巴克5%已額滿', body: `icash Pay 星巴克5% ${monthNum}月名額已滿` });
  for (const b of banks) { if (transport[b].full) promos.push({ id: `transport_${b}`, full: true, title: `交通10%額滿(${b})`, body: `icash Pay 交通10% ${b} ${monthNum}月名額已滿` }); }
  if (sundayFull) promos.push({ id: 'sunday_7', full: true, title: '週日7%已額滿', body: `icash Pay 週日7% ${monthNum}月名額已滿` });
  if (autoloadFull) promos.push({ id: 'uniopen_autoload', full: true, title: '自動加值10%已額滿', body: `uniopen自動加值10% ${monthNum}月名額已滿` });
  for (const a of ecActs) { if (ecResults[a.id]) promos.push({ id: a.id, full: true, title: a.title, body: a.body }); }
  if (ecResults['easycard_challenge_silver']) promos.push({ id: 'easycard_challenge_silver', full: true, title: '月級挑戰銀級已額滿', body: `悠遊付月級挑戰銀級 ${monthNum}月名額已滿` });
  if (ecResults['easycard_challenge_gold']) promos.push({ id: 'easycard_challenge_gold', full: true, title: '月級挑戰金級已額滿', body: `悠遊付月級挑戰金級 ${monthNum}月名額已滿` });
  if (ecResults['easycard_challenge_platinum']) promos.push({ id: 'easycard_challenge_platinum', full: true, title: '月級挑戰白金級已額滿', body: `悠遊付月級挑戰白金級 ${monthNum}月名額已滿` });

  // ===== 寫入 =====
  const newStatus = {
    uniopen_icash_full: icashFull, uniopen_icash_msg: icashMsg,
    starbucks_5_full: starbucksFull, starbucks_5_msg: starbucksMsg,
    sunday_7_full: sundayFull, sunday_7_msg: sundayMsg,
    uniopen_autoload_full: autoloadFull, uniopen_autoload_msg: autoloadMsg,
    transport_10: transport,
  };
  for (const a of ecActs) newStatus[a.id + '_full'] = ecResults[a.id];
  newStatus['easycard_challenge_silver_full'] = ecResults['easycard_challenge_silver'];
  newStatus['easycard_challenge_gold_full'] = ecResults['easycard_challenge_gold'];
  newStatus['easycard_challenge_platinum_full'] = ecResults['easycard_challenge_platinum'];
  newStatus.promos = promos;
  newStatus.updated = todayStr;

  const changed = JSON.stringify(currentStatus, null, 2) !== JSON.stringify(newStatus, null, 2);
  fs.writeFileSync(STATUS_FILE, JSON.stringify(newStatus, null, 2) + '\n');
  console.log(`\n狀態已更新`);
  console.log(changed ? 'STATUS_CHANGED=true' : 'STATUS_CHANGED=false');
}

checkPromo().catch(err => { console.error('執行失敗:', err); process.exit(1); });
