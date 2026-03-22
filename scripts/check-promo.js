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
  return { year, month, todayStr: `${year}-${month}-${String(now.getDate()).padStart(2, '0')}` };
}

async function checkPromo() {
  const { year, month, todayStr } = getMonthStr();
  const monthNum = String(parseInt(month));
  
  // 讀取現有狀態
  let currentStatus = {};
  try {
    currentStatus = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
  } catch (e) {
    console.log('無現有狀態檔，建立新檔');
  }

  // 新月份重置（每月前 3 天）
  const lastUpdated = currentStatus.updated || '';
  const lastMonth = lastUpdated ? lastUpdated.substring(0, 7) : '';
  const thisMonth = todayStr.substring(0, 7);
  const today = new Date();
  const needReset = thisMonth !== lastMonth && today.getDate() <= 3;

  // ===== 活動 1: icash Pay 4% 全通路 (id/2019) =====
  let icashFull = currentStatus.uniopen_icash_full || false;
  let icashMsg = currentStatus.uniopen_icash_msg || '';
  
  if (needReset) { icashFull = false; icashMsg = ''; }
  
  try {
    const page2019 = await fetchPage('https://www.icashpay.com.tw/advertMessage/view/id/2019');
    const regex2019 = new RegExp(year + '年' + monthNum + '月[\\s\\S]*?額滿', 'g');
    const match2019 = page2019.match(regex2019);
    if (match2019) {
      icashFull = true;
      icashMsg = `${year}年${monthNum}月 icash Pay 4% 加碼已額滿`;
      console.log(`[id/2019] 偵測到額滿: ${match2019[0].substring(0, 60)}`);
    } else {
      console.log('[id/2019] 本月尚未額滿');
    }
  } catch (e) {
    console.error('[id/2019] 抓取失敗:', e.message);
  }

  // ===== 活動 2: 交通運輸 10% (id/2037) =====
  // 五家銀行各自額滿
  const banks = ['台新', '兆豐', '一銀', '華南', '元大'];
  let transport = currentStatus.transport_10 || {};
  
  if (needReset) {
    transport = {};
    for (const bank of banks) {
      transport[bank] = { full: false, msg: '' };
    }
  } else {
    // 確保所有銀行都有初始值
    for (const bank of banks) {
      if (!transport[bank]) transport[bank] = { full: false, msg: '' };
    }
  }
  
  try {
    const page2037 = await fetchPage('https://www.icashpay.com.tw/advertMessage/view/id/2037');
    
    for (const bank of banks) {
      // 匹配格式：「台新03月份贈點已於2026/03/04 18:41 p.m.額滿」
      const regex = new RegExp(bank + monthNum.padStart(2, '0') + '月份贈點已於[\\s\\S]*?額滿');
      const match = page2037.match(regex);
      if (match) {
        transport[bank].full = true;
        transport[bank].msg = match[0].trim();
        console.log(`[id/2037] ${bank} 額滿: ${match[0].substring(0, 40)}`);
      } else {
        console.log(`[id/2037] ${bank} 本月尚未額滿`);
      }
    }
  } catch (e) {
    console.error('[id/2037] 抓取失敗:', e.message);
  }

  // 組合 promos 陣列（供 iOS 通知用）
  const promos = [];
  for (const bank of banks) {
    if (transport[bank].full) {
      promos.push({
        id: `transport_${bank}`,
        full: true,
        title: `交通10%額滿(${bank})`,
        body: `icash Pay 交通運輸10% ${bank}本月名額已滿`
      });
    }
  }

  // 寫入狀態
  const newStatus = {
    uniopen_icash_full: icashFull,
    uniopen_icash_msg: icashMsg,
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
