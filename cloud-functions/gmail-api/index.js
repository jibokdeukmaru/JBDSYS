// HTTP-triggered Cloud Function: 이메일 탭 전체(목록/본문/읽음처리/첨부/발송) 처리.
// Apps Script(ERP스크립트.txt)의 getGmailMessages/getGmailMessage/getGmailUnread/
// gmailBatchModify/getGmailAttachment/sendEmailFromERP를 그대로 옮긴 것 — 로직 동일.
const { google } = require('googleapis');

const SA_EMAIL = process.env.GMAIL_SA_EMAIL;
const SA_KEY = (process.env.GMAIL_SA_KEY || '').replace(/\\n/g, '\n');
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
// ★ 관리콘솔 도메인 위임에서 권한을 허용해도, 여기서 실제로 요청하는 scope 목록에
//   없으면 토큰에 그 권한이 안 붙는다 — 필터(자동분류) 기능은 gmail.settings.basic이 필요.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

function gmailClientFor(email) {
  const jwt = new google.auth.JWT({ email: SA_EMAIL, key: SA_KEY, scopes: SCOPES, subject: email });
  return google.gmail({ version: 'v1', auth: jwt });
}

function labelForFolder(folder) {
  switch (folder) {
    case 'sent': return 'SENT';
    case 'spam': return 'SPAM';
    case 'trash': return 'TRASH';
    case 'inbox': return 'INBOX';
    // ★ 그 외(예: 사용자가 만든 라벨 ID "Label_123...")는 그대로 labelIds 필터로 사용 —
    //   개인별 커스텀 폴더(라벨) 기능이 이 분기 하나로 getGmailMessages에 자동 연동된다.
    default: return folder;
  }
}

function mimeEncodeHeader(str) {
  str = String(str || '');
  if (!/[^\x00-\x7F]/.test(str)) return str;
  return '=?UTF-8?B?' + Buffer.from(str, 'utf8').toString('base64') + '?=';
}

function extractBody(payload) {
  const out = { html: '', text: '' };
  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || '';
    if (part.body && part.body.data) {
      const decoded = Buffer.from(part.body.data, 'base64').toString('utf8');
      if (mime === 'text/html' && !out.html) out.html = decoded;
      else if (mime === 'text/plain' && !out.text) out.text = decoded;
    }
    (part.parts || []).forEach(walk);
  }
  walk(payload);
  return out;
}

// 본문 HTML에 <img src="cid:xxx">로 참조되는 인라인 이미지 파트만 골라낸다.
function extractInlineImageParts(payload) {
  const out = [];
  function walk(part) {
    if (!part) return;
    const cidHeader = (part.headers || []).find((h) => (h.name || '').toLowerCase() === 'content-id');
    if (cidHeader && part.body && part.body.attachmentId) {
      const cid = String(cidHeader.value || '').replace(/^<|>$/g, '');
      if (cid) out.push({ cid, attachmentId: part.body.attachmentId, mimeType: part.mimeType || 'application/octet-stream' });
    }
    (part.parts || []).forEach(walk);
  }
  walk(payload);
  return out;
}

function base64UrlToStd(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return s;
}

// 본문 HTML 안의 cid: 참조를 실제 이미지 데이터(base64 data URI)로 치환 —
// 안 하면 인라인 이미지가 브라우저에서 깨진 아이콘으로만 보인다.
async function inlineCidImages(gmail, messageId, payload, html) {
  if (!html || html.indexOf('cid:') === -1) return html;
  const parts = extractInlineImageParts(payload);
  for (const part of parts) {
    const marker = 'cid:' + part.cid;
    if (html.indexOf(marker) === -1) continue;
    try {
      const attRes = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: part.attachmentId });
      const dataUri = 'data:' + part.mimeType + ';base64,' + base64UrlToStd(attRes.data.data);
      html = html.split(marker).join(dataUri);
    } catch (e) { /* 개별 이미지 변환 실패는 무시하고 나머지는 계속 진행 */ }
  }
  return html;
}

function extractAttachments(payload) {
  const out = [];
  function walk(part) {
    if (!part) return;
    if (part.filename && part.body && part.body.attachmentId) {
      out.push({
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    }
    (part.parts || []).forEach(walk);
  }
  walk(payload);
  return out;
}

async function getGmailMessages(p) {
  const email = (p.email || '').trim();
  const folder = (p.folder || 'inbox').trim();
  const max = parseInt(p.max || '20', 10);
  if (!email) return { status: 'error', message: 'email 없음' };
  const gmail = gmailClientFor(email);
  const label = labelForFolder(folder);
  const q = (p.q || '').trim();
  const pageToken = (p.pageToken || '').trim();
  try {
    const listRes = await gmail.users.messages.list({
      userId: 'me', maxResults: max, labelIds: [label],
      q: q || undefined, pageToken: pageToken || undefined,
    });
    const ids = (listRes.data.messages || []).map((m) => m.id);
    const items = await Promise.all(ids.map(async (id) => {
      const mRes = await gmail.users.messages.get({
        userId: 'me', id, format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });
      const m = mRes.data;
      const h = {};
      (m.payload && m.payload.headers || []).forEach((x) => { h[x.name] = x.value; });
      return {
        id, from: h.From || '', to: h.To || '', subject: h.Subject || '(제목없음)',
        date: h.Date || '', snippet: m.snippet || '',
        unread: (m.labelIds || []).indexOf('UNREAD') !== -1,
      };
    }));
    return { status: 'ok', messages: items, nextPageToken: listRes.data.nextPageToken || '' };
  } catch (err) {
    return { status: 'error', message: (err.errors && err.errors[0] && err.errors[0].message) || err.message };
  }
}

async function getGmailMessage(p) {
  const email = (p.email || '').trim();
  const id = (p.id || '').trim();
  if (!email || !id) return { status: 'error', message: 'email 또는 id 없음' };
  const gmail = gmailClientFor(email);
  try {
    const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const m = res.data;
    const h = {};
    (m.payload && m.payload.headers || []).forEach((x) => { h[x.name] = x.value; });
    const body = extractBody(m.payload);
    const attachments = extractAttachments(m.payload);
    if (body.html) body.html = await inlineCidImages(gmail, id, m.payload, body.html);
    return {
      status: 'ok',
      message: {
        id, from: h.From || '', to: h.To || '', cc: h.Cc || '',
        subject: h.Subject || '(제목없음)', date: h.Date || '',
        body: body.html || body.text || '', isHtml: !!body.html,
        attachments,
      },
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function getGmailUnread(p) {
  const email = (p.email || '').trim();
  if (!email) return { status: 'error', message: 'email 없음' };
  const gmail = gmailClientFor(email);
  try {
    const res = await gmail.users.labels.get({ userId: 'me', id: 'INBOX' });
    return { status: 'ok', unread: res.data.messagesUnread || 0, total: res.data.messagesTotal || 0 };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function gmailBatchModify(p) {
  const email = (p.email || '').trim();
  const op = (p.op || '').trim();
  const idsRaw = (p.ids || '').trim();
  if (!email || !op || !idsRaw) return { status: 'error', message: '필수 파라미터 누락(email, op, ids)' };
  const ids = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return { status: 'error', message: '선택된 메일 없음' };
  const gmail = gmailClientFor(email);
  try {
    if (op === 'trash' || op === 'untrash') {
      await Promise.all(ids.map((id) => (op === 'trash'
        ? gmail.users.messages.trash({ userId: 'me', id })
        : gmail.users.messages.untrash({ userId: 'me', id }))));
      return { status: 'ok', count: ids.length };
    }
    let addLabelIds = [], removeLabelIds = [];
    if (op === 'read') removeLabelIds = ['UNREAD'];
    else if (op === 'unread') addLabelIds = ['UNREAD'];
    else if (op === 'spam') addLabelIds = ['SPAM'];
    else if (op === 'unspam') removeLabelIds = ['SPAM'];
    else return { status: 'error', message: '알 수 없는 작업: ' + op };
    await gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids, addLabelIds, removeLabelIds } });
    return { status: 'ok', count: ids.length };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function getGmailAttachment(p) {
  const email = (p.email || '').trim();
  const id = (p.id || '').trim();
  const attachmentId = (p.attachmentId || '').trim();
  if (!email || !id || !attachmentId) return { status: 'error', message: '필수 파라미터 누락(email, id, attachmentId)' };
  const gmail = gmailClientFor(email);
  try {
    const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId: id, id: attachmentId });
    const bytes = Buffer.from(res.data.data, 'base64');
    return { status: 'ok', data: bytes.toString('base64') };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// ── 개인별 폴더(Gmail 라벨) ──
async function getGmailLabels(p) {
  const email = (p.email || '').trim();
  if (!email) return { status: 'error', message: 'email 없음' };
  const gmail = gmailClientFor(email);
  try {
    const res = await gmail.users.labels.list({ userId: 'me' });
    // 시스템 라벨(INBOX/SENT/SPAM 등)은 이미 고정 폴더로 있으니 제외, 사용자가 만든 것만
    const labels = (res.data.labels || [])
      .filter((l) => l.type === 'user')
      .map((l) => ({ id: l.id, name: l.name }));
    return { status: 'ok', labels };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function createGmailLabel(p) {
  const email = (p.email || '').trim();
  const name = (p.name || '').trim();
  if (!email || !name) return { status: 'error', message: '필수 파라미터 누락(email, name)' };
  const gmail = gmailClientFor(email);
  try {
    const res = await gmail.users.labels.create({
      userId: 'me',
      requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    return { status: 'ok', label: { id: res.data.id, name: res.data.name } };
  } catch (err) {
    return { status: 'error', message: (err.errors && err.errors[0] && err.errors[0].message) || err.message };
  }
}

async function deleteGmailLabel(p) {
  const email = (p.email || '').trim();
  const labelId = (p.labelId || '').trim();
  if (!email || !labelId) return { status: 'error', message: '필수 파라미터 누락(email, labelId)' };
  const gmail = gmailClientFor(email);
  try {
    await gmail.users.labels.delete({ userId: 'me', id: labelId });
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// 메일 여러 건에 커스텀 라벨 붙이기/떼기 — gmailBatchModify는 시스템 라벨(읽음/스팸 등) 전용이라
// 임의의 라벨 ID를 받는 이 액션을 따로 둔다.
async function gmailModifyLabel(p) {
  const email = (p.email || '').trim();
  const labelId = (p.labelId || '').trim();
  const op = (p.op || '').trim(); // 'add' | 'remove'
  const idsRaw = (p.ids || '').trim();
  if (!email || !labelId || !op || !idsRaw) return { status: 'error', message: '필수 파라미터 누락' };
  const ids = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return { status: 'error', message: '선택된 메일 없음' };
  const gmail = gmailClientFor(email);
  try {
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids,
        addLabelIds: op === 'add' ? [labelId] : [],
        removeLabelIds: op === 'remove' ? [labelId] : [],
      },
    });
    return { status: 'ok', count: ids.length };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// ── 발신주소 → 라벨 자동분류 (Gmail 필터) ──
// ★ 이 3개 액션(필터 조회/생성/삭제)은 gmail.modify 권한만으로는 안 되고, 관리콘솔에서
//   서비스계정 도메인 위임 범위에 https://www.googleapis.com/auth/gmail.settings.basic 를
//   추가로 허용해줘야 동작한다. 라벨(폴더) 기능은 기존 권한으로 바로 되지만 필터는 이 권한이
//   없으면 403 에러가 난다.
async function getGmailFilters(p) {
  const email = (p.email || '').trim();
  if (!email) return { status: 'error', message: 'email 없음' };
  const gmail = gmailClientFor(email);
  try {
    const res = await gmail.users.settings.filters.list({ userId: 'me' });
    const filters = (res.data.filter || []).map((f) => ({
      id: f.id,
      from: (f.criteria && f.criteria.from) || '',
      labelIds: (f.action && f.action.addLabelIds) || [],
    }));
    return { status: 'ok', filters };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// 발신주소 조건 → 라벨 자동적용 필터 생성. applyToExisting이면 이미 받은 메일에도 즉시 일괄 적용.
async function createGmailFilter(p) {
  const email = (p.email || '').trim();
  const from = (p.from || '').trim();
  const labelId = (p.labelId || '').trim();
  const applyToExisting = p.applyToExisting === 'true' || p.applyToExisting === true;
  if (!email || !from || !labelId) return { status: 'error', message: '필수 파라미터 누락(email, from, labelId)' };
  const gmail = gmailClientFor(email);
  try {
    const res = await gmail.users.settings.filters.create({
      userId: 'me',
      requestBody: { criteria: { from }, action: { addLabelIds: [labelId] } },
    });
    let existingCount = 0;
    if (applyToExisting) {
      const listRes = await gmail.users.messages.list({ userId: 'me', q: 'from:' + from, maxResults: 500 });
      const ids = (listRes.data.messages || []).map((m) => m.id);
      if (ids.length) {
        await gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids, addLabelIds: [labelId] } });
        existingCount = ids.length;
      }
    }
    return { status: 'ok', filterId: res.data.id, existingCount };
  } catch (err) {
    return { status: 'error', message: (err.errors && err.errors[0] && err.errors[0].message) || err.message };
  }
}

async function deleteGmailFilter(p) {
  const email = (p.email || '').trim();
  const filterId = (p.filterId || '').trim();
  if (!email || !filterId) return { status: 'error', message: '필수 파라미터 누락(email, filterId)' };
  const gmail = gmailClientFor(email);
  try {
    await gmail.users.settings.filters.delete({ userId: 'me', id: filterId });
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function sendEmailFromERP(p) {
  const to = (p.to || '').trim();
  const cc = (p.cc || '').trim();
  const subject = (p.subject || '').trim();
  const body = (p.body || '').trim();
  if (!to || !subject || !body) return { status: 'error', message: '필수 항목(to, subject, body)이 누락되었습니다.' };

  const senderEmail = (p.senderEmail || '').trim();
  const fromInput = (p.from || '').trim();
  const ALLOWED_SHARED = ['info@jibokdeukmaru.com', 'sales@jibokdeukmaru.com', 'rnd@jibokdeukmaru.com'];
  const fromAddr = (fromInput && (fromInput === senderEmail || ALLOWED_SHARED.indexOf(fromInput) !== -1)) ? fromInput : senderEmail;
  if (!fromAddr) return { status: 'error', message: '발신자 정보가 없습니다.' };

  const senderName = (p.senderName || '').trim();
  const senderTitle = (p.senderTitle || '').trim();
  const senderDept = (p.senderDept || '').trim();
  const senderPhone = (p.senderPhone || '').trim();

  const signature = senderName ? (
    '<table style="margin-top:32px;padding-top:20px;border-top:2px solid #E5D9C6;font-family:Arial,\'Noto Sans KR\',sans-serif;border-collapse:collapse;"><tr><td style="vertical-align:top;">' +
    '<div style="font-size:16px;font-weight:800;color:#2B2521;margin-bottom:2px;">' + senderName + (senderTitle ? ' <span style="font-size:13px;font-weight:600;color:#A2693E;">' + senderTitle + '</span>' : '') + '</div>' +
    (senderDept ? '<div style="font-size:12px;color:#888;margin-bottom:6px;">' + senderDept + '</div>' : '') +
    '<table style="border-collapse:collapse;font-size:12px;color:#666;line-height:1.9;">' +
    (senderPhone ? '<tr><td style="color:#A2693E;font-weight:700;padding-right:10px;white-space:nowrap;">T.</td><td>' + senderPhone + '</td></tr>' : '') +
    (senderEmail ? '<tr><td style="color:#A2693E;font-weight:700;padding-right:10px;">E.</td><td><a href="mailto:' + senderEmail + '" style="color:#A2693E;text-decoration:none;">' + senderEmail + '</a></td></tr>' : '') +
    '<tr><td style="color:#A2693E;font-weight:700;padding-right:10px;">W.</td><td><a href="https://jibokdeukmaru.com" style="color:#A2693E;text-decoration:none;">jibokdeukmaru.com</a></td></tr>' +
    '</table>' +
    '<div style="margin-top:10px;"><img src="https://sys.jibokdeukmaru.com/%EB%A1%9C%EA%B3%A0.png" alt="지복득마루" width="459" height="18" style="display:block;width:100%;max-width:459px;height:auto;"></div>' +
    '</td></tr></table>'
  ) : '';

  const attachments = Array.isArray(p.attachments) ? p.attachments : [];
  let imgTagsHtml = '';
  attachments.forEach((f, idx) => {
    const mimeType = f.mimeType || 'application/octet-stream';
    if (mimeType.indexOf('image/') === 0) {
      f._cid = 'img_' + idx + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
      imgTagsHtml += '<div style="margin-top:14px;"><img src="cid:' + f._cid + '" style="display:block;width:100%;max-width:560px;height:auto;border-radius:8px;"></div>';
    }
  });

  const escapedBody = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const htmlBody = '<div style="font-family:Arial,\'Noto Sans KR\',sans-serif;max-width:640px;margin:0 auto;padding:32px 24px;background:#fff;border:1px solid #e0d6ce;border-radius:10px;">' +
    '<div style="white-space:pre-line;font-size:14px;color:#1a1a1a;line-height:1.9;">' + escapedBody + '</div>' + imgTagsHtml + signature + '</div>';

  const senderDisplayName = senderName ? (senderName + (senderTitle ? ' ' + senderTitle : '') + ' | 지복득마루') : '지복득마루';
  const boundary = 'bnd_' + Date.now().toString(36) + Math.random().toString(36).slice(2);

  const headerLines = [];
  headerLines.push('From: ' + mimeEncodeHeader(senderDisplayName) + ' <' + fromAddr + '>');
  headerLines.push('To: ' + to);
  if (cc) headerLines.push('Cc: ' + cc);
  headerLines.push('Subject: ' + mimeEncodeHeader(subject));
  headerLines.push('MIME-Version: 1.0');
  headerLines.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');

  const parts = [];
  parts.push(
    '--' + boundary + '\r\n' +
    'Content-Type: text/html; charset="UTF-8"\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    Buffer.from(htmlBody, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
  );
  attachments.forEach((f) => {
    const data = String(f.data || '').split(',').pop();
    const mimeType = f.mimeType || 'application/octet-stream';
    const fname = (f.name || 'attachment').replace(/"/g, '');
    const disposition = f._cid
      ? 'Content-Disposition: inline; filename="' + fname + '"\r\n' + 'Content-ID: <' + f._cid + '>\r\n'
      : 'Content-Disposition: attachment; filename="' + fname + '"\r\n';
    parts.push(
      '--' + boundary + '\r\n' +
      'Content-Type: ' + mimeType + '; name="' + fname + '"\r\n' +
      disposition +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      data.replace(/(.{76})/g, '$1\r\n')
    );
  });

  const raw = headerLines.join('\r\n') + '\r\n\r\n' + parts.join('\r\n\r\n') + '\r\n--' + boundary + '--';
  const rawEncoded = Buffer.from(raw).toString('base64url');

  const gmail = gmailClientFor(fromAddr);
  try {
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: rawEncoded } });
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', message: (err.errors && err.errors[0] && err.errors[0].message) || err.message };
  }
}

exports.gmailApi = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  // ★ 클라이언트가 CORS 프리플라이트를 피하려고 Content-Type: text/plain으로 JSON을 보내는 경우가
  //   있어서(예: 이메일 발송), 그럴 땐 프레임워크가 req.body를 자동 파싱 안 해주고 문자열/버퍼로
  //   넘어온다 — 여기서 방어적으로 직접 파싱한다.
  let bodyObj = req.body;
  if (Buffer.isBuffer(bodyObj)) bodyObj = bodyObj.toString('utf8');
  if (typeof bodyObj === 'string') {
    try { bodyObj = JSON.parse(bodyObj); } catch (e) { bodyObj = {}; }
  }
  const params = Object.assign({}, req.query, bodyObj || {});
  if (params._appKey !== INTERNAL_KEY) {
    return res.status(403).json({ status: 'error', message: '인증 실패' });
  }
  const action = params.action;
  try {
    let result;
    switch (action) {
      case 'getGmailMessages': result = await getGmailMessages(params); break;
      case 'getGmailMessage': result = await getGmailMessage(params); break;
      case 'getGmailUnread': result = await getGmailUnread(params); break;
      case 'gmailBatchModify': result = await gmailBatchModify(params); break;
      case 'getGmailAttachment': result = await getGmailAttachment(params); break;
      case 'sendEmailFromERP': result = await sendEmailFromERP(params); break;
      case 'getGmailLabels': result = await getGmailLabels(params); break;
      case 'createGmailLabel': result = await createGmailLabel(params); break;
      case 'deleteGmailLabel': result = await deleteGmailLabel(params); break;
      case 'gmailModifyLabel': result = await gmailModifyLabel(params); break;
      case 'getGmailFilters': result = await getGmailFilters(params); break;
      case 'createGmailFilter': result = await createGmailFilter(params); break;
      case 'deleteGmailFilter': result = await deleteGmailFilter(params); break;
      default: result = { status: 'error', message: '알 수 없는 action: ' + action };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
};
