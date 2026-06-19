// =============================================================
// lib/sheets.js — 구글 시트를 데이터베이스처럼 사용
//  - Plants 탭: 개체(보증서) 데이터
//  - Logs 탭: 발송 내역 (없으면 자동 생성)
// =============================================================

const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID;
const PLANTS_SHEET = process.env.SHEET_NAME || 'Plants';
const LOGS_SHEET = process.env.LOGS_SHEET || 'Logs';
const LOG_HEADERS = ['일시', '고유번호', '품종명', '소유자', '전화번호', '채널', '상태'];
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

function getCredentials() {
  if (!SERVICE_ACCOUNT_JSON) throw new Error('환경변수 GOOGLE_SERVICE_ACCOUNT_JSON 이 설정되지 않았습니다.');
  try { return JSON.parse(SERVICE_ACCOUNT_JSON); }
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 값이 올바른 JSON 형식이 아닙니다.'); }
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function getRows(sheetName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: sheetName });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => (h || '').toString().trim());
  return rows.slice(1).map((row, idx) => {
    const obj = { _rowNumber: idx + 2 };
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i].toString() : ''; });
    return obj;
  });
}

async function getAllRows() { return getRows(PLANTS_SHEET); }

async function findById(id) {
  if (!id) return null;
  const target = id.toString().trim().toUpperCase();
  const rows = await getRows(PLANTS_SHEET);
  return rows.find((r) => (r['고유번호'] || '').trim().toUpperCase() === target) || null;
}

async function getHeaders(sheetName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: sheetName + '!1:1' });
  return (res.data.values && res.data.values[0] ? res.data.values[0] : []).map((h) => (h || '').toString().trim());
}

async function updateRow(rowNumber, updates) {
  const sheets = await getSheetsClient();
  const headers = await getHeaders(PLANTS_SHEET);
  const data = [];
  for (const key of Object.keys(updates)) {
    const colIndex = headers.indexOf(key);
    if (colIndex === -1) continue;
    data.push({ range: PLANTS_SHEET + '!' + columnLetter(colIndex + 1) + rowNumber, values: [[updates[key]]] });
  }
  if (data.length === 0) return;
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data } });
}

async function appendToSheet(sheetName, obj) {
  const sheets = await getSheetsClient();
  const headers = await getHeaders(sheetName);
  if (headers.length === 0) throw new Error("시트 '" + sheetName + "' 1행(헤더)이 비어 있습니다.");
  const newRow = headers.map((h) => (obj[h] !== undefined && obj[h] !== null ? obj[h].toString() : ''));
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: sheetName,
    valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [newRow] },
  });
}

async function appendRow(obj) { return appendToSheet(PLANTS_SHEET, obj); }

async function ensureSheet(name, headers) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties' });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === name);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: name } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: name + '!A1', valueInputOption: 'USER_ENTERED', requestBody: { values: [headers] } });
  }
}

// 전화번호를 텍스트로 강제(앞자리 0 유지): USER_ENTERED에서 작은따옴표 접두사는 "텍스트로 처리"
function phoneAsText(v) {
  const s = (v || '').toString().trim();
  if (!s) return '';
  return /^[0-9]+$/.test(s) ? "'" + s : s;
}

async function appendLog(log) {
  await ensureSheet(LOGS_SHEET, LOG_HEADERS);
  const safe = Object.assign({}, log);
  safe['전화번호'] = phoneAsText(safe['전화번호']);
  await appendToSheet(LOGS_SHEET, safe);
}

async function getLogs() {
  await ensureSheet(LOGS_SHEET, LOG_HEADERS);
  return (await getRows(LOGS_SHEET)).reverse();
}

async function getSheetIdByName(name) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties' });
  const found = (meta.data.sheets || []).find((s) => s.properties.title === name);
  if (!found) throw new Error("시트 탭 '" + name + "' 를 찾지 못했습니다.");
  return found.properties.sheetId;
}

async function deleteLogRow(rowNumber) {
  const sheets = await getSheetsClient();
  const sheetId = await getSheetIdByName(LOGS_SHEET);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } } }] },
  });
}

function columnLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

module.exports = {
  PLANTS_SHEET, LOGS_SHEET, LOG_HEADERS,
  getAllRows, getRows, getHeaders, findById, updateRow,
  appendRow, appendToSheet, appendLog, getLogs, deleteLogRow, ensureSheet,
};
