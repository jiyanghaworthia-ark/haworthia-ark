// =============================================================
// lib/sheets.js
// 구글 시트를 데이터베이스처럼 사용하기 위한 모듈입니다.
// 서비스 계정(JSON 키)으로 인증하고, 시트의 첫 줄(헤더)을 키로 사용해
// 각 행을 { 고유번호, 품종명, ... } 형태의 객체로 변환해 줍니다.
// =============================================================

const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Plants';
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

function getCredentials() {
  if (!SERVICE_ACCOUNT_JSON) {
    throw new Error('환경변수 GOOGLE_SERVICE_ACCOUNT_JSON 이 설정되지 않았습니다. README 4단계를 확인하세요.');
  }
  try {
    return JSON.parse(SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 값이 올바른 JSON 형식이 아닙니다.');
  }
}

async function getSheetsClient() {
  const credentials = getCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

// 시트 전체를 읽어 [{헤더1: 값, ...}, ...] 배열로 반환
async function getAllRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_NAME });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => (h || '').toString().trim());
  return rows.slice(1).map((row, idx) => {
    const obj = { _rowNumber: idx + 2 };
    headers.forEach((h, i) => {
      obj[h] = row[i] !== undefined ? row[i].toString() : '';
    });
    return obj;
  });
}

// 고유번호로 개체 1건 찾기
async function findById(id) {
  if (!id) return null;
  const target = id.toString().trim().toUpperCase();
  const rows = await getAllRows();
  return rows.find((r) => (r['고유번호'] || '').trim().toUpperCase() === target) || null;
}

// 특정 행의 특정 컬럼 값 업데이트
async function updateRow(rowNumber, updates) {
  const sheets = await getSheetsClient();
  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_NAME + '!1:1' });
  const headers = (headerRes.data.values && headerRes.data.values[0] ? headerRes.data.values[0] : []).map((h) => (h || '').toString().trim());
  const data = [];
  for (const key of Object.keys(updates)) {
    const colIndex = headers.indexOf(key);
    if (colIndex === -1) continue;
    const colLetter = columnLetter(colIndex + 1);
    data.push({ range: SHEET_NAME + '!' + colLetter + rowNumber, values: [[updates[key]]] });
  }
  if (data.length === 0) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
}

// 새 개체(행) 추가
async function appendRow(obj) {
  const sheets = await getSheetsClient();
  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_NAME + '!1:1' });
  const headers = (headerRes.data.values && headerRes.data.values[0] ? headerRes.data.values[0] : []).map((h) => (h || '').toString().trim());
  if (headers.length === 0) {
    throw new Error('시트 1행(헤더)이 비어 있습니다. README 2단계의 제목 줄을 먼저 입력하세요.');
  }
  const newRow = headers.map((h) => (obj[h] !== undefined && obj[h] !== null ? obj[h].toString() : ''));
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [newRow] },
  });
}

// 1 -> A, 2 -> B ... 27 -> AA
function columnLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

module.exports = { getAllRows, findById, updateRow, appendRow };
