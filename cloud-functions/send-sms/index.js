// HTTP-triggered Cloud Function: SOLAPI SMS 발송 (Apps Script UrlFetch 일일 한도 우회).
const crypto = require('crypto');
const fetch = require('node-fetch');

const API_KEY = process.env.SOLAPI_API_KEY;
const API_SECRET = process.env.SOLAPI_API_SECRET;
const SENDER = process.env.SOLAPI_SENDER;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;

function sign(apiSecret) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString('hex');
  const signature = crypto.createHmac('sha256', apiSecret).update(date + salt).digest('hex');
  return { date, salt, signature };
}

exports.sendSms = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const params = Object.assign({}, req.query, req.body || {});
  if (params._appKey !== INTERNAL_KEY) {
    return res.status(403).json({ status: 'error', message: '인증 실패' });
  }
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
