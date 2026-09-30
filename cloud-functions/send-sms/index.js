// HTTP-triggered Cloud Function: SOLAPI SMS 발송 (Apps Script UrlFetch 일일 한도 우회).
//
// ★ (2026-09-30 보안) 예전엔 공유 비밀키(_appKey)만 맞으면 누구의 요청이든 문자를 보냈는데, 그 키는
//   ERP 웹페이지 소스에 그대로 들어 있어 외부인도 회사 번호로 문자를 보낼 수 있었다. 이제 두 경로만 허용한다.
//   1) ERP 화면(직원 수동 발송): ERP 로그인 때 발급되는 Firebase 로그인 토큰(_idToken)을 검증
//   2) 예약 스크립트(자동 발송, 직원 로그인 없음): 웹페이지에 없는 서버 전용 키(_serverKey = env SERVER_API_KEY)
//   전환 기간에는 ALLOW_LEGACY_KEY=1 이면 예전 공유키도 받아준다(전환 완료 후 0으로 바꿔 차단).
//   dryRun=1 이면 인증만 확인하고 실제 문자는 보내지 않는다(자동발송 경로 점검용).
const crypto = require('crypto');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const API_KEY = process.env.SOLAPI_API_KEY;
const API_SECRET = process.env.SOLAPI_API_SECRET;
const SENDER = process.env.SOLAPI_SENDER;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const SERVER_KEY = process.env.SERVER_API_KEY || '';
const ALLOW_LEGACY_KEY = String(process.env.ALLOW_LEGACY_KEY || '') === '1';

function sign(apiSecret) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString('hex');
  const signature = crypto.createHmac('sha256', apiSecret).update(date + salt).digest('hex');
  return { date, salt, signature };
}

// 길이가 같을 때만 비교(타이밍 공격 방지)
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// 로그인한 직원인지 확인 — 토큰의 email 클레임(auth-api가 발급 시 넣음), 없으면 employees/{uid}
async function isEmployeeToken(idToken) {
  if (!idToken) return false;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (decoded.email) return true;
    const snap = await admin.firestore().collection('employees').doc(decoded.uid).get();
    return snap.exists && !!(snap.data() || {}).email;
  } catch (e) {
    return false;
  }
}

// 반환: 'server' | 'employee' | 'legacy' | null
async function authorize(params, req) {
  if (SERVER_KEY && safeEqual(params._serverKey, SERVER_KEY)) return 'server';
  const authHeader = String((req.get && req.get('Authorization')) || '');
  const idToken = String(params._idToken || '').trim() || (authHeader.indexOf('Bearer ') === 0 ? authHeader.slice(7) : '');
  if (await isEmployeeToken(idToken)) return 'employee';
  if (ALLOW_LEGACY_KEY && INTERNAL_KEY && safeEqual(params._appKey, INTERNAL_KEY)) return 'legacy';
  return null;
}

exports.sendSms = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const params = Object.assign({}, req.query, req.body || {});
  const via = await authorize(params, req);
  if (!via) {
    return res.status(403).json({ status: 'error', message: '인증 실패 — ERP에서는 로그아웃 후 다시 로그인해 주세요.' });
  }
  if (String(params.dryRun || '') === '1') {
    return res.json({ status: 'ok', dryRun: true, via, message: '인증 확인됨(문자는 보내지 않음)' });
  }
  if (via === 'legacy') console.warn('send-sms: 예전 공유키로 호출됨(전환 기간) — 호출한 곳을 새 방식으로 바꿔야 함');

  const receiver = params.receiver;
  const msg = params.msg;
  if (!receiver || !msg) {
    return res.status(400).json({ status: 'error', message: '필수 파라미터 누락(receiver, msg)' });
  }
  if (!API_KEY || !API_SECRET || !SENDER) {
    return res.json({ status: 'error', message: '솔라피 API 설정 없음' });
  }

  const { date, salt, signature } = sign(API_SECRET);
  const to = String(receiver).replace(/[^0-9]/g, '');
  const from = String(SENDER).replace(/[^0-9]/g, '');

  try {
    const r = await fetch('https://api.solapi.com/messages/v4/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `HMAC-SHA256 apiKey=${API_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
      },
      body: JSON.stringify({ message: { to, from, text: msg } }),
    });
    const data = await r.json();
    const code = String(data.statusCode || (data.groupInfo && data.groupInfo.status) || '');
    if (code === '2000' || code === '3000' || data.messageId) {
      return res.json({ status: 'ok', message: '발송성공' });
    }
    return res.json({ status: 'error', message: data.statusMessage || data.errorMessage || data.message || '발송실패' });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
};
