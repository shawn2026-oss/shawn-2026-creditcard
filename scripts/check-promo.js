/**
 * 自動檢查 icash Pay UniOpen 加碼活動額滿狀態
 * 由 GitHub Actions 每天定時執行
 * 
 * 目標頁面：https://www.icashpay.com.tw/advertMessage/view/id/1982
 * 偵測格式：「2026年X月【全通路不限金額消費享4%】活動贈點已於...額滿」
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const TARGET_URL = 'https://www.icashpay.com.tw/advertMessage/view/id/1982';
const STATUS_FILE = path.join(__dirname, '..', 'promo_status.json');

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      timeout: 15000 
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function checkPromo() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  
  console.log(`[${now.toISOString()}] 檢查 ${year}年${month}月 icash Pay 額滿狀態...`);
  
  // 讀取現有狀態
  let currentStatus = {};
  try {
    currentStatus = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch (e) {
    console.log('找不到現有狀態檔，建立新檔');
  }
  
  let isFull = false;
  let fullDate = '';
  
  try {
    const html = await fetchPage(TARGET_URL);
    console.log(`頁面載入成功，長度：${html.length}`);
    
    const textContent = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    
    // 精準匹配當月額滿公告
    // 格式：2026年2月【全通路不限金額消費享4%】活動贈點已於2026/2/10 12:00 pm額滿
    const pattern = new RegExp(
      year + '年' + month + '月[\\s\\S]*?額滿'
    );
    
    const match = textContent.match(pattern);
    
    if (match) {
      isFull = true;
      fullDate = match[0];
      console.log('偵測到當月額滿：「' + fullDate + '」');
    } else {
      console.log(year + '年' + month + '月 尚未額滿');
    }
    
  } catch (err) {
    console.error('頁面抓取失敗：' + err.message);
    console.log('保持現有狀態不變');
    return;
  }
  
  // 每月若偵測不到當月額滿紀錄，自動重置
  const todayStr = now.toISOString().split('T')[0];
  const lastMonth = (currentStatus.updated || '').substring(0, 7);
  const thisMonth = todayStr.substring(0, 7);
  
  if (thisMonth !== lastMonth && !isFull) {
    console.log('新月份（' + thisMonth + '），重置額滿狀態');
  }
  
  const newStatus = {
    uniopen_icash_full: isFull,
    uniopen_icash_msg: isFull ? year + '年' + month + '月 icash Pay 4%加碼已額滿' : '',
    uniopen_icash_date: isFull ? fullDate : '',
    updated: todayStr
  };
  
  const changed = currentStatus.uniopen_icash_full !== newStatus.uniopen_icash_full;
  
  fs.writeFileSync(STATUS_FILE, JSON.stringify(newStatus, null, 2) + '\n');
  console.log('狀態：' + JSON.stringify(newStatus));
  console.log('STATUS_CHANGED=' + changed);
}

checkPromo().catch(function(err) {
  console.error('執行失敗：', err);
  process.exit(1);
});


