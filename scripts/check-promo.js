const https = require('https');
const fs = require('fs');

const STATUS_FILE = 'promo_status.json';

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function getMonthStr() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return { year, month, monthNum: String(parseInt(month)), todayStr: `${year}-${month}-${String(now.getDate()).padStart(2, '0')}` };
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

  // ===== 活動 4: ID=12654 — uniopen icash2.0 自動加值 10% =====
  let autoloadFull = currentStatus.uniopen_autoload_full || false;
  let autoloadMsg = currentStatus.uniopen_autoload_msg || '';
  
  if (needReset) { autoloadFull = false; autoloadMsg = ''; }
  
  try {
   const page12654raw = await fetchPage('https://www.icash.com.tw/Home/NewsDetail/?ID=12654');
    const page12654 = page12654raw.replace(/<[^>]+>/g, '');
    const regexAutoload = new RegExp(monthNum + '月[\\s\\S]*?自動加值[\\s\\S]*?額滿');
    const matchAutoload = page12654.match(regexAutoload);
    if (matchAutoload) {
      autoloadFull = true;
      autoloadMsg = `${year}年${monthNum}月 uniopen自動加值10%已額滿`;
      console.log(`[ID=12654] 自動加值10%額滿: ${matchAutoload[0].substring(0, 60)}`);
    } else {
      console.log('[ID=12654] 自動加值10% 本月尚未額滿');
    }
  } catch (e) {
    console.error('[ID=12654] 抓取失敗:', e.message);
  }

  // 組合 promos 陣列
  const promos = [];
  for (const bank of banks) {
    if (transport[bank].full) {
      promos.push({ id: `transport_${bank}`, full: true, title: `交通10%額滿(${bank})`, body: `icash Pay 交通運輸10% ${bank}本月名額已滿` });
    }
  }
  if (starbucksFull) {
    promos.push({ id: 'starbucks_5', full: true, title: '星巴克5%已額滿', body: 'icash Pay 星巴克筆筆5%本月名額已滿' });
  }
  if (sundayFull) {
    promos.push({ id: 'sunday_7', full: true, title: '週日7%已額滿', body: 'icash Pay 週日全通路7%本月名額已滿' });
  }
  if (autoloadFull) {
    promos.push({ id: 'uniopen_autoload', full: true, title: '自動加值10%已額滿', body: 'uniopen聯名卡icash2.0自動加值10%本月名額已滿' });
  }

  // 寫入狀態
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
