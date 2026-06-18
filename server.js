// =============================================================
// server.js — 지양하월시아 방주 프로젝트 디지털 보증서 시스템
//   GET  /                   → 손님 공개 조회 페이지 (고유번호 입력)
//   POST /find               → 고유번호로 보증서 페이지 이동
//   GET  /certificate/:id    → 디지털 보증서 페이지
//   GET  /admin              → 관리자 로그인 / 보증서 발송
//   GET  /admin/new          → 개체 등록 폼
//   POST /admin/new          → 개체 등록 처리
//   POST /admin/send         → 보증서 링크 발송 (+ 발송내역 기록)
//   GET  /admin/logs         → 발송내역 보기
//   POST /admin/logs/add     → 발송내역 수동 추가
//   POST /admin/logs/delete  → 발송내역 삭제
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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'jiyang-ark-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 },
  })
);

function certificateUrl(req, id) {
  const base = BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/certificate/${encodeURIComponent(id)}`;
}

app.get('/healthz', (req, res) => res.send('ok'));

// 손님 공개 조회 페이지
app.get('/', (req, res) => res.render('lookup', { error: null }));

// 고유번호 입력 → 보증서로 이동
app.post('/find', (req, res) => {
  const id = (req.body.id || '').trim();
  if (!id) return res.render('lookup', { error: '고유번호를 입력해 주세요.' });
  res.redirect('/certificate/' + encodeURIComponent(id));
});

// 보증서 페이지
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

function requireLogin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin');
}

app.get('/admin', (req, res) => {
  if (req.session && req.session.isAdmin) return res.render('admin', { result: null, error: null, form: {} });
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('login', { error: '비밀번호가 올바르지 않습니다.' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

// 다음 RG 일련번호 추천 (예: 기존 RG0762 -> RG0763)
async function suggestNextSerial() {
  let max = 0;
  try {
    const rows = await sheets.getAllRows();
    rows.forEach((r) => {
      const m = (r['고유번호'] || '').trim().match(/RG0*(\d+)\s*$/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > max) max = n;
      }
    });
  } catch (e) {
    console.warn('번호 추천 경고:', e.message);
  }
  return 'RG' + String(max + 1).padStart(4, '0');
}

// 개체 등록 폼
app.get('/admin/new', requireLogin, async (req, res) => {
  const nextSerial = await suggestNextSerial();
  res.render('register', { error: null, result: null, form: {}, nextSerial });
});

// 개체 등록 처리
app.post('/admin/new', requireLogin, async (req, res) => {
  const b = req.body;
  const form = {
    고유번호: (b['고유번호'] || '').trim(),
    품종명: (b['품종명'] || '').trim(),
    영문명: (b['영문명'] || '').trim(),
    등급: (b['등급'] || '').trim() || '로얄골드',
    종: (b['종'] || '').trim(),
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
    const exists = await sheets.findById(form['고유번호']);
    if (exists) throw new Error('고유번호 "' + form['고유번호'] + '" 는 이미 등록되어 있습니다. 다른 번호를 사용하세요.');
    await sheets.appendRow(form);
    const url = certificateUrl(req, form['고유번호']);
    res.render('register', {
      error: null,
      form: {},
      nextSerial: await suggestNextSerial(),
      result: { 고유번호: form['고유번호'], 품종명: form['품종명'], url },
    });
  } catch (err) {
    console.error(err);
    res.render('register', { error: err.message, form, result: null, nextSerial: form['고유번호'] });
  }
});

// 보증서 발송
app.post('/admin/send', requireLogin, async (req, res) => {
  const form = {
    id: (req.body.id || '').trim(),
    name: (req.body.name || '').trim(),
    phone: (req.body.phone || '').trim(),
  };
  try {
    if (!form.id) throw new Error('제품(고유)번호를 입력하세요.');
    if (!form.phone) throw new Error('고객 휴대폰 번호를 입력하세요.');
    const plant = await sheets.findById(form.id);
    if (!plant) throw new Error('고유번호 "' + form.id + '" 에 해당하는 개체를 시트에서 찾지 못했습니다.');

    const today = new Date().toISOString().slice(0, 10);
    const updates = { 발급일: today };
    if (form.name) updates['소유자'] = form.name;
    try {
      await sheets.updateRow(plant._rowNumber, updates);
    } catch (e) {
      console.warn('시트 업데이트 경고:', e.message);
    }

    const url = certificateUrl(req, form.id);
    const sendResult = await messaging.sendCertificate({ to: form.phone, name: form.name || plant['소유자'] || '', url });

    // 발송 내역 기록
    try {
      await sheets.appendLog({
        일시: nowString(),
        고유번호: form.id,
        품종명: plant['품종명'] || '',
        전화번호: form.phone,
        채널: sendResult.channel,
        상태: '성공',
      });
    } catch (e) {
      console.warn('발송내역 기록 경고:', e.message);
    }

    res.render('admin', {
      error: null,
      form: {},
      result: { channel: sendResult.channel, id: form.id, variety: plant['품종명'] || '', phone: form.phone, url },
    });
  } catch (err) {
    console.error(err);
    res.render('admin', { error: err.message, form, result: null });
  }
});

// 발송내역 보기
app.get('/admin/logs', requireLogin, async (req, res) => {
  try {
    const logs = await sheets.getLogs();
    res.render('logs', { logs, error: null, notice: req.query.msg || null });
  } catch (err) {
    console.error(err);
    res.render('logs', { logs: [], error: err.message, notice: null });
  }
});

// 발송내역 수동 추가
app.post('/admin/logs/add', requireLogin, async (req, res) => {
  try {
    await sheets.appendLog({
      일시: (req.body['일시'] || '').trim() || nowString(),
      고유번호: (req.body['고유번호'] || '').trim(),
      품종명: (req.body['품종명'] || '').trim(),
      전화번호: (req.body['전화번호'] || '').trim(),
      채널: (req.body['채널'] || '').trim() || '수동',
      상태: (req.body['상태'] || '').trim() || '성공',
    });
    res.redirect('/admin/logs?msg=' + encodeURIComponent('내역을 추가했습니다.'));
  } catch (err) {
    console.error(err);
    res.render('logs', { logs: await safeLogs(), error: err.message, notice: null });
  }
});

// 발송내역 삭제
app.post('/admin/logs/delete', requireLogin, async (req, res) => {
  try {
    const rowNumber = parseInt(req.body.rowNumber, 10);
    if (!rowNumber || rowNumber < 2) throw new Error('삭제할 행 번호가 올바르지 않습니다.');
    await sheets.deleteLogRow(rowNumber);
    res.redirect('/admin/logs?msg=' + encodeURIComponent('내역을 삭제했습니다.'));
  } catch (err) {
    console.error(err);
    res.render('logs', { logs: await safeLogs(), error: err.message, notice: null });
  }
});

async function safeLogs() {
  try { return await sheets.getLogs(); } catch (e) { return []; }
}

function nowString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

app.listen(PORT, () => {
  console.log('✅ 방주 보증서 서버가 실행되었습니다. 포트: ' + PORT);
  if (!BASE_URL) console.log('ℹ️  BASE_URL 환경변수가 비어 있습니다. 배포 후 도메인을 BASE_URL에 넣어주세요.');
});
