// =============================================================
// lib/messaging.js
// 솔라피(Solapi) REST API로 알림톡 / 문자(LMS)를 발송하는 모듈입니다.
// 외부 SDK 없이 Node 기본 기능(crypto, fetch)만 사용합니다.
//
// 동작 방식:
//  - 환경변수에 알림톡 템플릿(ALIMTALK_TEMPLATE_ID)과 발신프로필(KAKAO_PFID)이
//    모두 설정되어 있으면 → 알림톡으로 발송 (실패 시 자동으로 문자 대체)
//  - 설정되어 있지 않으면 → 문자(LMS)로 발송
//  이렇게 하면 알림톡 템플릿 승인 전이라도 문자로 먼저 운영을 시작할 수 있습니다.
// =============================================================

const crypto = require('crypto');

const SOLAPI_API_KEY = process.env.SOLAPI_API_KEY;
const SOLAPI_API_SECRET = process.env.SOLAPI_API_SECRET;
const SENDER_PHONE = process.env.SENDER_PHONE;          // 솔라피에 등록한 발신번호 (예: 01012345678)

// 알림톡 관련 (선택) — 확정되면 채워주세요
const KAKAO_PFID = process.env.KAKAO_PFID;              // 카카오 발신프로필 ID (pfId)
const ALIMTALK_TEMPLATE_ID = process.env.ALIMTALK_TEMPLATE_ID; // 승인된 알림톡 템플릿 ID
// 템플릿 안의 변수명(#{...})에 맞춰 매핑합니다. 템플릿이 다르면 .env에서 바꿀 수 있습니다.
const VAR_NAME_KEY = process.env.ALIMTALK_VAR_NAME || '#{고객명}';
const VAR_LINK_KEY = process.env.ALIMTALK_VAR_LINK || '#{링크}';

// ---- 솔라피 인증 서명(HMAC-SHA256) 생성 ----
function buildAuthHeader() {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString('hex');
  const signature = crypto
    .createHmac('sha256', SOLAPI_API_SECRET)
    .update(date + salt)
    .digest('hex');
  return `HMAC-SHA256 apiKey=${SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

// ---- 솔라피로 메시지 1건 전송 (공통) ----
async function sendViaSolapi(message) {
  if (!SOLAPI_API_KEY || !SOLAPI_API_SECRET) {
    throw new Error('SOLAPI_API_KEY / SOLAPI_API_SECRET 환경변수가 없습니다. README 5단계를 확인하세요.');
  }
  if (!SENDER_PHONE) {
    throw new Error('SENDER_PHONE(발신번호) 환경변수가 없습니다. 솔라피에 등록한 발신번호를 넣어주세요.');
  }

  const res = await fetch('https://api.solapi.com/messages/v4/send', {
    method: 'POST',
    headers: {
      Authorization: buildAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data.errorMessage || data.message || JSON.stringify(data);
    throw new Error(`솔라피 발송 실패 (${res.status}): ${reason}`);
  }
  return data;
}

// ---- 문자(LMS)로 발송 ----
async function sendSms(to, text) {
  return sendViaSolapi({
    to: onlyDigits(to),
    from: onlyDigits(SENDER_PHONE),
    text,
  });
}

// ---- 알림톡으로 발송 (실패 시 문자 자동 대체) ----
async function sendAlimtalk(to, name, url, fallbackText) {
  const message = {
    to: onlyDigits(to),
    from: onlyDigits(SENDER_PHONE),
    kakaoOptions: {
      pfId: KAKAO_PFID,
      templateId: ALIMTALK_TEMPLATE_ID,
      variables: {
        [VAR_NAME_KEY]: name || '고객',
        [VAR_LINK_KEY]: url,
      },
      // 알림톡 발송 실패 시 문자로 대체 발송
      disableSms: false,
    },
  };
  // 대체 문자 내용(알림톡 실패 시 사용)
  if (fallbackText) message.text = fallbackText;
  return sendViaSolapi(message);
}

// ---- 외부에서 호출하는 메인 함수 ----
// 알림톡 설정이 갖춰져 있으면 알림톡, 아니면 문자로 발송합니다.
async function sendCertificate({ to, name, url }) {
  const text =
    `[지양하월시아 방주 프로젝트]\n` +
    `${name ? name + ' 님, ' : ''}소장하신 하월시아의 디지털 보증서가 발급되었습니다.\n` +
    `아래 링크에서 확인하세요.\n${url}`;

  const useAlimtalk = KAKAO_PFID && ALIMTALK_TEMPLATE_ID;
  if (useAlimtalk) {
    const result = await sendAlimtalk(to, name, url, text);
    return { channel: '알림톡', result };
  } else {
    const result = await sendSms(to, text);
    return { channel: '문자(LMS)', result };
  }
}

// 전화번호에서 숫자만 추출 (010-1234-5678 -> 01012345678)
function onlyDigits(s) {
  return (s || '').toString().replace(/[^0-9]/g, '');
}

module.exports = { sendCertificate, sendSms, sendAlimtalk };
