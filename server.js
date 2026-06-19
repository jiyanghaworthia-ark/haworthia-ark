// =============================================================
// server.js — 지양하월시아 방주 프로젝트 디지털 보증서 시스템
// =============================================================

require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const sheets = require('./lib/sheets');
const messaging = require('./lib/messaging');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

// Plants 시트 컬럼 순서(등록/내보내기 기준)
const PLANTS_HEADERS = ['고유번호','품종명','영문명','종','등급','자구번식묘','육종가','육종연도','모본','부본','DNA마커','사진URL','소유자','소유이력','발급일','관리자메시지','상태'];

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'jiyang-ark-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 },
}));

function certificateUrl(req, id) {
  const base = BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/certificate/${encodeURIComponent(id)}`;
}
function nowString() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function today() { return new Date().toISOString().slice(0, 10); }

// ---- CSV 유틸 ----
function csvCell(v) { v = (v == null ? '' : String(v)); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  rows.forEach((r) => lines.push(r.map(csvCell).join(',')));
  return '﻿' + lines.join('\r\n');
}
function parseCsv(text) {
  text = (text || '').replace(/^﻿/, '');
  const rows = []; let row = [], field = '', i = 0, inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++; continue;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0].trim() === ''));
}
function csvToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => (h || '').trim());
  return rows.slice(1).map((r) => {
    const o = {}; headers.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : ''; }); return o;
  });
}
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(csv);
}

app.get('/healthz', (req, res) => res.send('ok'));

// ===== 손님 공개 조회 =====
app.get('/', (req, res) => res.render('lookup', { error: null }));
app.post('/find', (req, res) => {
  const id = (req.body.id || '').trim();
  if (!id) return res.render('lookup', { error: '고유번호를 입력해 주세요.' });
  res.redirect('/certificate/' + encodeURIComponent(id));
});
app.get('/certificate/:id', async (req, res) => {
  try {
    const plant = await sheets.findById(req.params.id);
    if (!plant) return res.status(404).render('not_found', { id: req.params.id });
    res.render('certificate', { plant, pageUrl: certificateUrl(req, req.params.id) });
  } catch (err) {
    console.error(err);
    res.status(500).send('보증서를 불러오는 중 오류가 발생했습니다: ' + err.message);
  }
});

// ===== 관리자 =====
function requireLogin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin');
}
app.get('/admin', (req, res) => {
  if (req.session && req.session.isAdmin) return res.render('admin', { result: null, error: null, form: {} });
  res.render('login', { error: null });
});
app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) { req.session.isAdmin = true; return res.redirect('/admin'); }
  res.render('login', { error: '비밀번호가 올바르지 않습니다.' });
});
app.post('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/admin')));

async function suggestNextSerial() {
  let max = 0;
  try {
    (await sheets.getAllRows()).forEach((r) => {
      const m = (r['고유번호'] || '').trim().match(/RG0*(\d+)\s*$/i);
      if (m) { const n = parseInt(m[1], 10); if (!isNaN(n) && n > max) max = n; }
    });
  } catch (e) { console.warn('번호 추천 경고:', e.message); }
  return 'RG' + String(max + 1).padStart(4, '0');
}

// 개체 등록 폼
app.get('/admin/new', requireLogin, async (req, res) => {
  res.render('register', { error: null, result: null, form: {}, nextSerial: await suggestNextSerial() });
});
app.post('/admin/new', requireLogin, async (req, res) => {
  const b = req.body;
  const form = {
    고유번호: (b['고유번호'] || '').trim(),
    품종명: (b['품종명'] || '').trim(),
    영문명: (b['영문명'] || '').trim(),
    종: (b['종'] || '').trim(),
    등급: (b['등급'] || '').trim() || '로얄골드',
    자구번식묘: b['자구번식묘'] ? '예' : '',
    육종가: (b['육종가'] || '').trim() || '지양하월시아',
    육종연도: (b['육종연도'] || '').trim(),
    모본: (b['모본'] || '').trim(),
    부본: (b['부본'] || '').trim(),
    DNA마커: (b['DNA마커'] || '').trim(),
    사진URL: (b['사진URL'] || '').trim(),
    소유자: (b['소유자'] || '').trim(),
    소유이력: (b['소유이력'] || '').trim(),
    관리자메시지: (b['관리자메시지'] || '').trim(),
    상태: (b['상태'] || '').trim() || '정품 인증',
  };
  try {
    if (!form['고유번호']) throw new Error('고유번호는 필수입니다.');
    if (!form['품종명']) throw new Error('품종명은 필수입니다.');
    if (await sheets.findById(form['고유번호'])) throw new Error('고유번호 "' + form['고유번호'] + '" 는 이미 등록되어 있습니다.');
    await sheets.appendRow(form);
    res.render('register', {
      error: null, form: {}, nextSerial: await suggestNextSerial(),
      result: { 고유번호: form['고유번호'], 품종명: form['품종명'], url: certificateUrl(req, form['고유번호']) },
    });
  } catch (err) {
    console.error(err);
    res.render('register', { error: err.message, form, result: null, nextSerial: form['고유번호'] });
  }
});

// 등록 내역 보기
app.get('/admin/plants', requireLogin, async (req, res) => {
  try {
    const plants = (await sheets.getAllRows()).reverse();
    res.render('plants', { plants, error: null, notice: req.query.msg || null });
  } catch (err) {
    console.error(err);
    res.render('plants', { plants: [], error: err.message, notice: null });
  }
});

// 등록 내역 CSV 다운로드
app.get('/admin/plants.csv', requireLogin, async (req, res) => {
  try {
    let headers = await sheets.getHeaders(sheets.PLANTS_SHEET);
    if (!headers.length) headers = PLANTS_HEADERS;
    const rows = await sheets.getAllRows();
    sendCsv(res, 'plants_backup.csv', toCsv(headers, rows.map((r) => headers.map((h) => r[h] || ''))));
  } catch (err) { res.status(500).send('내보내기 오류: ' + err.message); }
});

// 등록 내역 CSV 업로드(가져오기) — 중복 고유번호는 건너뜀
app.post('/admin/plants/import', requireLogin, async (req, res) => {
  try {
    const objs = csvToObjects(req.body.csv || '');
    const existing = new Set((await sheets.getAllRows()).map((r) => (r['고유번호'] || '').trim().toUpperCase()));
    let added = 0, skipped = 0;
    for (const o of objs) {
      const id = (o['고유번호'] || '').trim();
      if (!id) { skipped++; continue; }
      if (existing.has(id.toUpperCase())) { skipped++; continue; }
      await sheets.appendRow(o); existing.add(id.toUpperCase()); added++;
    }
    res.redirect('/admin/plants?msg=' + encodeURIComponent(`가져오기 완료: ${added}건 추가, ${skipped}건 건너뜀`));
  } catch (err) {
    console.error(err);
    res.render('plants', { plants: await safePlants(), error: '가져오기 오류: ' + err.message, notice: null });
  }
});

// ===== 보증서 발송 =====
app.post('/admin/send', requireLogin, async (req, res) => {
  const form = { id: (req.body.id || '').trim(), name: (req.body.name || '').trim(), phone: (req.body.phone || '').trim() };
  try {
    if (!form.id) throw new Error('제품(고유)번호를 입력하세요.');
    if (!form.phone) throw new Error('고객 휴대폰 번호를 입력하세요.');
    const plant = await sheets.findById(form.id);
    if (!plant) throw new Error('고유번호 "' + form.id + '" 에 해당하는 개체를 시트에서 찾지 못했습니다.');

    // 소유권 이전: 소유이력에 한 줄 누적 + 소유자/발급일 갱신
    const updates = { 발급일: today() };
    if (form.name) {
      const prev = (plant['소유이력'] || '').trim();
      const lines = [];
      if (prev) lines.push(prev);
      else lines.push((plant['육종연도'] || '') + ' | 최초 육종 (' + (plant['육종가'] || '지양하월시아') + ')');
      lines.push(today() + ' | ' + form.name + ' 소유');
      updates['소유이력'] = lines.join('\n');
      updates['소유자'] = form.name;
    }
    try { await sheets.updateRow(plant._rowNumber, updates); }
    catch (e) { console.warn('시트 업데이트 경고:', e.message); }

    const url = certificateUrl(req, form.id);
    const sendResult = await messaging.sendCertificate({ to: form.phone, name: form.name || plant['소유자'] || '', url });

    try {
      await sheets.appendLog({
        일시: nowString(), 고유번호: form.id, 품종명: plant['품종명'] || '',
        소유자: form.name || plant['소유자'] || '', 전화번호: form.phone,
        채널: sendResult.channel, 상태: '성공',
      });
    } catch (e) { console.warn('발송내역 기록 경고:', e.message); }

    res.render('admin', { error: null, form: {}, result: { channel: sendResult.channel, id: form.id, variety: plant['품종명'] || '', phone: form.phone, url } });
  } catch (err) {
    console.error(err);
    res.render('admin', { error: err.message, form, result: null });
  }
});

// ===== 발송 내역 =====
app.get('/admin/logs', requireLogin, async (req, res) => {
  try { res.render('logs', { logs: await sheets.getLogs(), error: null, notice: req.query.msg || null }); }
  catch (err) { console.error(err); res.render('logs', { logs: [], error: err.message, notice: null }); }
});
app.post('/admin/logs/add', requireLogin, async (req, res) => {
  try {
    await sheets.appendLog({
      일시: (req.body['일시'] || '').trim() || nowString(),
      고유번호: (req.body['고유번호'] || '').trim(), 품종명: (req.body['품종명'] || '').trim(),
      소유자: (req.body['소유자'] || '').trim(), 전화번호: (req.body['전화번호'] || '').trim(),
      채널: (req.body['채널'] || '').trim() || '수동', 상태: (req.body['상태'] || '').trim() || '성공',
    });
    res.redirect('/admin/logs?msg=' + encodeURIComponent('내역을 추가했습니다.'));
  } catch (err) { console.error(err); res.render('logs', { logs: await safeLogs(), error: err.message, notice: null }); }
});
app.post('/admin/logs/delete', requireLogin, async (req, res) => {
  try {
    const rowNumber = parseInt(req.body.rowNumber, 10);
    if (!rowNumber || rowNumber < 2) throw new Error('삭제할 행 번호가 올바르지 않습니다.');
    await sheets.deleteLogRow(rowNumber);
    res.redirect('/admin/logs?msg=' + encodeURIComponent('내역을 삭제했습니다.'));
  } catch (err) { console.error(err); res.render('logs', { logs: await safeLogs(), error: err.message, notice: null }); }
});
app.get('/admin/logs.csv', requireLogin, async (req, res) => {
  try {
    const headers = sheets.LOG_HEADERS;
    const rows = await sheets.getLogs();
    sendCsv(res, 'logs_backup.csv', toCsv(headers, rows.map((r) => headers.map((h) => r[h] || ''))));
  } catch (err) { res.status(500).send('내보내기 오류: ' + err.message); }
});
app.post('/admin/logs/import', requireLogin, async (req, res) => {
  try {
    const objs = csvToObjects(req.body.csv || '');
    let added = 0;
    for (const o of objs) { await sheets.appendLog(o); added++; }
    res.redirect('/admin/logs?msg=' + encodeURIComponent(`가져오기 완료: ${added}건 추가`));
  } catch (err) { console.error(err); res.render('logs', { logs: await safeLogs(), error: '가져오기 오류: ' + err.message, notice: null }); }
});

async function safeLogs() { try { return await sheets.getLogs(); } catch (e) { return []; } }
async function safePlants() { try { return (await sheets.getAllRows()).reverse(); } catch (e) { return []; } }

app.listen(PORT, () => {
  console.log('✅ 방주 보증서 서버 실행. 포트: ' + PORT);
  if (!BASE_URL) console.log('ℹ️  BASE_URL 미설정 — 배포 후 도메인을 넣어주세요.');
});
