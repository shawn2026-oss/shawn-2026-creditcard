/**
 * 自動檢查活動額滿狀態
 * GitHub Actions 每天台灣時間 10/14/18/22 點執行
 *
 * 偵測來源：
 * 1. icash Pay 4% 全通路 + 星巴克 5%  (icashpay.com.tw id/2019)
 * 2. icash Pay 交通運輸 10%（五家銀行）(icashpay.com.tw id/2037)
 * 3. icash Pay 週日全通路 7%           (icashpay.com.tw id/1954)
 * 4. uniopen 自動加值 10%             (icash.com.tw ID=12654，需 cookie)
 * 5. 悠遊付 週五會員日 元大加碼        (easycard.com.tw id=1747884970)
 * 6. 悠遊付 乘車碼 10%               (easycard.com.tw id=1771988018)
 * 7. 悠遊付 日常美食 2%              (easycard.com.tw id=1765765539)
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

// icash.com.tw 需要帶 cookie 才拿到內容
function fetchPageWithCookie(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      console.log('[fetchPageWithCookie] 超時 10 秒，放棄');
      resolve('');
    }, 10000);

    let redirectCount = 0;
    let allCookies = '';

    function doGet(targetUrl) {
      if (redirectCount++ > 5) { clearTimeout(timer); resolve(''); return; }
      const headers = { 'User-Agent': 'Mozilla/5.0' };
      if (allCookies) headers['Cookie'] = allCookies;

      const mod = targetUrl.startsWith('https') ? https : http;
      mod.get(targetUrl, { headers }, (res) => {
        const setCookies = res.headers['set-cookie'];
        if (setCookies) {
          const newCookies = setCookies.map(c => c.split(';')[0]).join('; ');
          allCookies = allCookies ? allCookies + '; ' + newCookies : newCookies;
        }

        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, targetUrl).href;
          res.resume();
          return doGet(redirectUrl);
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
  return {
    year,
    month,
    monthNum: String(now.getMonth() + 1),
    todayStr: `${year}-${month}-${String(now.getDate()).padStart(2, '0')}`
  };
}

async function checkPromo() {
  const { year, month, monthNum, todayStr } = getMonthStr();

  let currentStatus = {};
  try {
    currentStatus = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
  } catch (e) {
    console.log('無現有狀態檔，建立新檔');
  }

  const lastUpdated = currentStatus.updated || '';
  const lastMonth = lastUpdated ? lastUpdated.substring(0, 7) : '';
  const thisMonth = todayStr.substring(0, 7);
  const today = new Date();
  const needReset = thisMonth !== lastMonth && today.getDate() <= 3;

  // ===== 活動 1: id/2019 — icash Pay 4% 全通路 + 星巴克 5% =====
  let icashFull = currentStatus.uniopen_icash_full || false;
  let icashMsg = currentStatus.uniopen_icash_msg || '';
  let starbucksFull = currentStatus.starbucks_5_full || false;
  let starbucksMsg = currentStatus.starbucks_5_msg || '';

  if (needReset) { icashFull = false; icashMsg = ''; starbucksFull = false; starbucksMsg = ''; }

  try {
    const page2019 = await fetchPage('https://www.icashpay.com.tw/advertMessage/view/id/2019');
    const regexAll = new RegExp(year + '年' + monthNum + '月[\\s\\S]*?額滿', 'g');
    const matches = page2019.match(regexAll);
    if (matches) {
      for (const m of matches) {
        if (m.includes('筆筆回饋5%') || m.includes('筆筆饋5%')) {
          starbucksFull = true;
          starbucksMsg = `${year}年${monthNum}月 星巴克筆筆5%已額滿`;
          console.log(`[id/2019] 星巴克5%額滿: ${m.substring(0, 50)}`);
        } else if (m.includes('全通路') || m.includes('不限金額')) {
          icashFull = true;
          icashMsg = `${year}年${monthNum}月 icash Pay 4%加碼已額滿`;
          console.log(`[id/2019] icash Pay 4%額滿: ${m.substring(0, 50)}`);
        }
      }
    }
    if (!icashFull) console.log('[id/2019] icash Pay 4% 本月尚未額滿');
    if (!starbucksFull) console.log('[id/2019] 星巴克5% 本月尚未額滿');
  } catch (e) {
    console.error('[id/2019] 抓取失敗:', e.message);
  }

  // ===== 活動 2: id/2037 — 交通運輸 10% =====
  const banks = ['台新', '兆豐', '一銀', '華南', '元大'];
  let transport = currentStatus.transport_10 || {};

  if (needReset) {
    transport = {};
    for (const bank of banks) transport[bank] = { full: false, msg: '' };
  } else {
    for (const bank of banks) if (!transport[bank]) transport[bank] = { full: false, msg: '' };
  }

  try {
    const page2037 = await fetchPage('https://www.icashpay.com.tw/advertMessage/view/id/2037');
    for (const bank of banks) {
      const regex = new RegExp(bank + monthNum.padStart(2, '0') + '月份贈點已於[\\s\\S]*?額滿');
      const match = page2037.match(regex);
      if (match) {
        transport[bank].full = true;
        transport[bank].msg = match[0].replace(/&nbsp;/g, ' ').trim();
        console.log(`[id/2037] ${bank} 額滿: ${match[0].substring(0, 40)}`);
      } else {
        console.log(`[id/2037] ${bank} 本月尚未額滿`);
      }
    }
  } catch (e) {
    console.error('[id/2037] 抓取失敗:', e.message);
  }

  // ===== 活動 3: id/1954 — 週日 7% 全通路 =====
  let sundayFull = currentStatus.sunday_7_full || false;
  let sundayMsg = currentStatus.sunday_7_msg || '';

  if (needReset) { sundayFull = false; sundayMsg = ''; }

  try {
    const page1954 = await fetchPage('https://www.icashpay.com.tw/advertMessage/view/id/1954');
    const regexSunday = new RegExp(year + '年' + monthNum + '月[\\s\\S]*?週日[\\s\\S]*?額滿');
    const matchSunday = page1954.match(regexSunday);
    if (matchSunday) {
      sundayFull = true;
      sundayMsg = `${year}年${monthNum}月 週日7%全通路已額滿`;
      console.log(`[id/1954] 週日7%額滿: ${matchSunday[0].substring(0, 50)}`);
    } else {
      console.log('[id/1954] 週日7% 本月尚未額滿');
    }
  } catch (e) {
    console.error('[id/1954] 抓取失敗:', e.message);
  }

  // ===== 活動 4: ID=12654 — uniopen 自動加值 10% (icash.com.tw 需 cookie) =====
  let autoloadFull = currentStatus.uniopen_autoload_full || false;
  let autoloadMsg = currentStatus.uniopen_autoload_msg || '';

  if (needReset) { autoloadFull = false; autoloadMsg = ''; }

  try {
    const page12654raw = await fetchPageWithCookie('https://www.icash.com.tw/Home/NewsDetail?ID=12654');
    const page12654 = page12654raw.replace(/<[^>]+>/g, '');
    if (page12654.length > 100) {
      const regexAutoload = new RegExp(monthNum + '月[\\s\\S]*?加值[\\s\\S]*?額滿');
      const matchAutoload = page12654.match(regexAutoload);
      if (matchAutoload) {
        autoloadFull = true;
        autoloadMsg = `${year}年${monthNum}月 uniopen自動加值10%已額滿`;
        console.log(`[ID=12654] 自動加值10%額滿: ${matchAutoload[0].substring(0, 60)}`);
      } else {
        console.log('[ID=12654] 自動加值10% 本月尚未額滿');
      }
    } else {
      console.log('[ID=12654] 頁面內容過短，可能抓取失敗');
    }
  } catch (e) {
    console.error('[ID=12654] 抓取失敗:', e.message);
  }

  // ===== 活動 5: 悠遊付 週五會員日 元大加碼 (easycard.com.tw) =====
  let yuantaFull = currentStatus.easycard_yuanta_full || false;
  let yuantaMsg = currentStatus.easycard_yuanta_msg || '';

  if (needReset) { yuantaFull = false; yuantaMsg = ''; }

  try {
    const pageYuanta = await fetchPage('https://www.easycard.com.tw/offer?cls=1506473490%2C1506473503%2C1508721809%2C1508721884%2C&id=1747884970');
    const textYuanta = pageYuanta.replace(/<[^>]+>/g, ' ');
    // 格式：元大銀行每週五3月份加碼已於2026/03/06 00:44:20額滿
    const regexYuanta = new RegExp('元大銀行每週五' + monthNum + '月份加碼已於[\\s\\S]*?額滿');
    const matchYuanta = textYuanta.match(regexYuanta);
    if (matchYuanta) {
      yuantaFull = true;
      yuantaMsg = `悠遊付週五會員日 元大${monthNum}月份加碼已額滿`;
      console.log(`[easycard] 元大加碼額滿: ${matchYuanta[0].substring(0, 60)}`);
    } else {
      console.log('[easycard] 元大加碼 本月尚未額滿');
    }
  } catch (e) {
    console.error('[easycard] 元大加碼抓取失敗:', e.message);
  }

  // ===== 活動 6: 悠遊付 乘車碼 10% (easycard.com.tw) =====
  let rideFull = currentStatus.easycard_ride_full || false;
  let rideMsg = currentStatus.easycard_ride_msg || '';

  if (needReset) { rideFull = false; rideMsg = ''; }

  try {
    const pageRide = await fetchPage('https://www.easycard.com.tw/offer?cls=1508721884%2C1506473490%2C1506473503%2C&id=1771988018');
    const textRide = pageRide.replace(/<[^>]+>/g, ' ');
    // 格式：*本活動一 已於2026/3/13 17:31:32 額滿
    const regexRide = new RegExp('本活動一\\s*已於' + year + '/' + monthNum + '/[\\s\\S]*?額滿');
    const matchRide = textRide.match(regexRide);
    if (matchRide) {
      rideFull = true;
      rideMsg = `悠遊付乘車碼10% ${monthNum}月已額滿`;
      console.log(`[easycard] 乘車碼額滿: ${matchRide[0].substring(0, 60)}`);
    } else {
      // 備用：不帶年份的格式
      const regexRide2 = /本活動一\s*已於[\s\S]*?額滿/;
      const matchRide2 = textRide.match(regexRide2);
      if (matchRide2 && matchRide2[0].includes(year + '/')) {
        rideFull = true;
        rideMsg = `悠遊付乘車碼10% ${monthNum}月已額滿`;
        console.log(`[easycard] 乘車碼額滿(備用): ${matchRide2[0].substring(0, 60)}`);
      } else {
        console.log('[easycard] 乘車碼10% 本月尚未額滿');
      }
    }
  } catch (e) {
    console.error('[easycard] 乘車碼抓取失敗:', e.message);
  }

  // ===== 活動 7: 悠遊付 日常美食 2% (easycard.com.tw) =====
  let foodFull = currentStatus.easycard_food_full || false;
  let foodMsg = currentStatus.easycard_food_msg || '';

  if (needReset) { foodFull = false; foodMsg = ''; }

  try {
    const pageFood = await fetchPage('https://www.easycard.com.tw/offer?cls=1506473503%2C1508721809%2C1506473490%2C&id=1765765539');
    const textFood = pageFood.replace(/<[^>]+>/g, ' ');
    // 格式：※3月於3/14(五)12:00:00額滿  或  ※1月於1/24(六)12:29:47額滿
    const regexFood = new RegExp('※' + monthNum + '月於[\\s\\S]*?額滿');
    const matchFood = textFood.match(regexFood);
    if (matchFood) {
      foodFull = true;
      foodMsg = `悠遊付日常美食2% ${monthNum}月已額滿`;
      console.log(`[easycard] 日常美食額滿: ${matchFood[0].substring(0, 60)}`);
    } else {
      console.log('[easycard] 日常美食2% 本月尚未額滿');
    }
  } catch (e) {
    console.error('[easycard] 日常美食抓取失敗:', e.message);
  }

  // ===== 組合 promos 陣列 =====
  const promos = [];

  // icash Pay 系列
  if (icashFull) {
    promos.push({ id: 'icash_4', full: true, title: 'icash Pay 4%已額滿', body: `icash Pay 全通路4%加碼${monthNum}月名額已滿` });
  }
  if (starbucksFull) {
    promos.push({ id: 'starbucks_5', full: true, title: '星巴克5%已額滿', body: `icash Pay 星巴克筆筆5% ${monthNum}月名額已滿` });
  }
  for (const bank of banks) {
    if (transport[bank].full) {
      promos.push({ id: `transport_${bank}`, full: true, title: `交通10%額滿(${bank})`, body: `icash Pay 交通運輸10% ${bank}${monthNum}月名額已滿` });
    }
  }
  if (sundayFull) {
    promos.push({ id: 'sunday_7', full: true, title: '週日7%已額滿', body: `icash Pay 週日全通路7% ${monthNum}月名額已滿` });
  }
  if (autoloadFull) {
    promos.push({ id: 'uniopen_autoload', full: true, title: '自動加值10%已額滿', body: `uniopen聯名卡icash2.0自動加值10% ${monthNum}月名額已滿` });
  }

  // 悠遊付系列
  if (yuantaFull) {
    promos.push({ id: 'easycard_yuanta', full: true, title: '悠遊付元大加碼已額滿', body: `悠遊付週五會員日 元大銀行${monthNum}月份加碼名額已滿` });
  }
  if (rideFull) {
    promos.push({ id: 'easycard_ride', full: true, title: '悠遊付乘車碼10%已額滿', body: `悠遊付乘車碼筆筆10%回饋 ${monthNum}月名額已滿` });
  }
  if (foodFull) {
    promos.push({ id: 'easycard_food', full: true, title: '悠遊付日常美食2%已額滿', body: `悠遊付日常美食滿額2%回饋 ${monthNum}月名額已滿` });
  }

  // ===== 寫入狀態 =====
  const newStatus = {
    uniopen_icash_full: icashFull,
    uniopen_icash_msg: icashMsg,
    starbucks_5_full: starbucksFull,
    starbucks_5_msg: starbucksMsg,
    sunday_7_full: sundayFull,
    sunday_7_msg: sundayMsg,
    uniopen_autoload_full: autoloadFull,
    uniopen_autoload_msg: autoloadMsg,
    transport_10: transport,
    easycard_yuanta_full: yuantaFull,
    easycard_yuanta_msg: yuantaMsg,
    easycard_ride_full: rideFull,
    easycard_ride_msg: rideMsg,
    easycard_food_full: foodFull,
    easycard_food_msg: foodMsg,
    promos: promos,
    updated: todayStr
  };

  const oldJson = JSON.stringify(currentStatus, null, 2);
  const newJson = JSON.stringify(newStatus, null, 2);
  const changed = oldJson !== newJson;

  fs.writeFileSync(STATUS_FILE, newJson + '\n');
  console.log(`\n狀態已更新: ${newJson}`);
  console.log(changed ? 'STATUS_CHANGED=true' : 'STATUS_CHANGED=false');
}

checkPromo().catch(err => {
  console.error('執行失敗:', err);
  process.exit(1);
});
