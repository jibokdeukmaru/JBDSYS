// HTTP-triggered Cloud Function: 이메일 탭 전체(목록/본문/읽음처리/첨부/발송) 처리.
// Apps Script(ERP스크립트.txt)의 getGmailMessages/getGmailMessage/getGmailUnread/
// gmailBatchModify/getGmailAttachment/sendEmailFromERP를 그대로 옮긴 것 — 로직 동일.
const { google } = require('googleapis');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const SA_EMAIL = process.env.GMAIL_SA_EMAIL;
const SA_KEY = (process.env.GMAIL_SA_KEY || '').replace(/\\n/g, '\n');
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
// ★ 관리콘솔 도메인 위임에서 권한을 허용해도, 여기서 실제로 요청하는 scope 목록에
//   없으면 토큰에 그 권한이 안 붙는다 — 필터(자동분류) 기능은 gmail.settings.basic이 필요.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

// ★ (2026-09-30 속도) 예전엔 요청마다 JWT를 새로 만들어 매번 구글 인증(토큰 교환)을 다시 받았다 —
//   같은 서버 인스턴스 안에서는 메일함별 클라이언트를 재사용한다(JWT가 액세스 토큰을 보관·자동 갱신).
const _gmailClients = new Map();
function gmailClientFor(email) {
  const key = String(email || '').trim().toLowerCase();
  let client = _gmailClients.get(key);
  if (!client) {
    const jwt = new google.auth.JWT({ email: SA_EMAIL, key: SA_KEY, scopes: SCOPES, subject: email });
    client = google.gmail({ version: 'v1', auth: jwt });
    _gmailClients.set(key, client);
  }
  return client;
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

// ★ (2026-09-30) 본문을 무조건 UTF-8로 읽어서 EUC-KR(ks_c_5601) 한글 메일이 깨지던 문제 —
//   파트의 Content-Type charset을 보고 해당 인코딩으로 디코딩한다(Node 내장 TextDecoder, full ICU).
function decodePartData(part) {
  const buf = Buffer.from(part.body.data, 'base64');
  const ct = ((part.headers || []).find((h) => (h.name || '').toLowerCase() === 'content-type') || {}).value || '';
  const m = ct.match(/charset\s*=\s*"?([^";\s]+)/i);
  const cs = m ? m[1].toLowerCase() : 'utf-8';
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii') return buf.toString('utf8');
  try { return new TextDecoder(cs).decode(buf); } catch (e) { return buf.toString('utf8'); }
}

function extractBody(payload) {
  const out = { html: '', text: '' };
  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || '';
    if (part.body && part.body.data) {
      const decoded = decodePartData(part);
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
  // ★ (2026-09-30 속도) 이미지를 하나씩 순서대로 받던 것을 동시에 받는다(이미지 많은 메일이 느리던 문제)
  const parts = extractInlineImageParts(payload).filter((part) => html.indexOf('cid:' + part.cid) !== -1);
  const results = await Promise.all(parts.map(async (part) => {
    try {
      const attRes = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: part.attachmentId });
      return ['cid:' + part.cid, 'data:' + part.mimeType + ';base64,' + base64UrlToStd(attRes.data.data)];
    } catch (e) { return null; } // 개별 이미지 변환 실패는 무시하고 나머지는 계속 진행
  }));
  results.forEach((r) => { if (r) html = html.split(r[0]).join(r[1]); });
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
    // ★ Gmail엔 "보관함"이라는 실제 라벨이 없다 — 받은편지함 라벨만 뗀 상태라서, labelIds
    //   필터 대신 검색어로 "받은편지함/스팸/휴지통/보낸/임시보관함이 아닌 것"을 찾아야 한다.
    const isArchive = folder === 'archive';
    const listRes = await gmail.users.messages.list({
      userId: 'me', maxResults: max,
      labelIds: isArchive ? undefined : [label],
      q: isArchive ? ('-in:inbox -in:sent -in:draft -in:spam -in:trash' + (q ? ' ' + q : '')) : (q || undefined),
      pageToken: pageToken || undefined,
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
        // 사용자가 만든 라벨(개인 폴더)만 — 목록에 칩으로 표시하는 용도. INBOX/UNREAD/CATEGORY_* 같은
        // 시스템 라벨은 제외(Gmail이 만든 라벨 ID는 전부 대문자라 소문자 포함 여부로 구분됨).
        labelIds: (m.labelIds || []).filter((id) => id.indexOf('Label_') === 0),
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
    // 헤더 이름 대소문자가 메일마다 달라서(Message-ID / Message-Id 등) 대소문자 무시하고 찾는다
    const hv = (name) => { const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase()); return k ? h[k] : ''; };
    return {
      status: 'ok',
      message: {
        id, from: h.From || '', to: h.To || '', cc: h.Cc || '',
        subject: h.Subject || '(제목없음)', date: h.Date || '',
        body: body.html || body.text || '', isHtml: !!body.html,
        attachments,
        // ★ (2026-09-30) 답장이 같은 대화(스레드)로 이어지고 회신 주소로 가도록
        threadId: m.threadId || '', messageId: hv('Message-ID'), references: hv('References'), replyTo: hv('Reply-To'),
      },
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// ★ (2026-09-22) 사이드바에 폴더별(스팸/휴지통/보관함/커스텀 라벨) 안읽은 개수를 같이
//   보여달라는 요청으로 확장 — 기존엔 INBOX 하나만 고정 조회했지만, 이제 쉼표로 여러
//   라벨 id를 한 번에 받아 병렬로 조회한다(호출 수를 늘리지 않기 위해). 보관함은 실제
//   Gmail 라벨이 없어서(받은편지함 라벨만 뗀 상태) 검색 쿼리로 대신 센다.
async function getGmailUnread(p) {
  const email = (p.email || '').trim();
  if (!email) return { status: 'error', message: 'email 없음' };
  const idsParam = (p.labelIds || 'INBOX').trim();
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
  const gmail = gmailClientFor(email);
  try {
    const entries = await Promise.all(ids.map(async (id) => {
      try {
        if (id === 'ARCHIVE') {
          const res = await gmail.users.messages.list({
            userId: 'me', maxResults: 1,
            q: 'is:unread -in:inbox -in:sent -in:draft -in:spam -in:trash',
          });
          return [id, res.data.resultSizeEstimate || 0];
        }
        const res = await gmail.users.labels.get({ userId: 'me', id });
        return [id, res.data.messagesUnread || 0];
      } catch (e) {
        return [id, 0];
      }
    }));
    const counts = Object.fromEntries(entries);
    // 하위호환: 기존 클라이언트는 INBOX 기준 단일 unread 필드만 봄
    return { status: 'ok', unread: counts.INBOX || 0, counts };
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
    // 완전삭제(복구 불가) — 휴지통 화면에서 "삭제"를 누르면 이미 휴지통에 있는 메일이라
    // trash가 아니라 이걸 써야 한다.
    if (op === 'delete') {
      await Promise.all(ids.map((id) => gmail.users.messages.delete({ userId: 'me', id })));
      return { status: 'ok', count: ids.length };
    }
    let addLabelIds = [], removeLabelIds = [];
    if (op === 'read') removeLabelIds = ['UNREAD'];
    else if (op === 'unread') addLabelIds = ['UNREAD'];
    else if (op === 'spam') addLabelIds = ['SPAM'];
    // 스팸해제는 Gmail "스팸 아님"과 같게 받은편지함으로 돌려놓는다(SPAM만 떼면 어느 폴더에도
    // 안 속해 보관함에만 보이게 됨).
    else if (op === 'unspam') { removeLabelIds = ['SPAM']; addLabelIds = ['INBOX']; }
    else if (op === 'archive') removeLabelIds = ['INBOX']; // 받은편지함에서만 뺌(삭제 아님)
    else if (op === 'unarchive') addLabelIds = ['INBOX'];
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
// ★ 이 액션(필터 생성)은 gmail.modify 권한만으로는 안 되고, 관리콘솔에서
//   서비스계정 도메인 위임 범위에 https://www.googleapis.com/auth/gmail.settings.basic 를
//   추가로 허용해줘야 동작한다. 라벨(폴더) 기능은 기존 권한으로 바로 되지만 필터는 이 권한이
//   없으면 403 에러가 난다.
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
    // ★ googleapis 에러 객체는 err.message가 짧게 요약돼서(예: "Insufficient Permission")
    //   진짜 원인(스코프 문제인지, 다른 이유인지) 구분이 안 될 때가 있어 상세 필드를 다 넣는다.
    const detail = (err.response && err.response.data) || err.errors || null;
    return { status: 'error', message: err.message, code: err.code, detail: detail ? JSON.stringify(detail) : undefined };
  }
}

// ── 수신거부(발신주소 차단) ──
// 스팸 신고가 아니라 "이 주소에서 오는 메일은 받은편지함 대신 바로 휴지통으로" 가는 Gmail 필터를
// 만든다. 차단 목록은 별도 저장 없이 Gmail 필터 중 이 형태(from 조건만 + 휴지통 이동)인 것들로 본다.
function isBlockFilter(fl) {
  const c = fl.criteria || {}, a = fl.action || {};
  return !!c.from && !c.to && !c.subject && !c.query && !c.negatedQuery
    && (a.addLabelIds || []).includes('TRASH');
}

async function blockSender(p) {
  const email = (p.email || '').trim();
  const from = (p.from || '').trim().toLowerCase();
  const trashExisting = p.trashExisting === 'true' || p.trashExisting === true;
  if (!email || !from) return { status: 'error', message: '필수 파라미터 누락(email, from)' };
  const gmail = gmailClientFor(email);
  try {
    // 이미 같은 주소로 차단돼 있으면 필터를 또 만들지 않는다(같은 필터 중복 생성은 Gmail이 에러 냄).
    const listRes = await gmail.users.settings.filters.list({ userId: 'me' });
    const existing = (listRes.data.filter || []).find((fl) => isBlockFilter(fl) && String(fl.criteria.from).toLowerCase() === from);
    let filterId = existing ? existing.id : null;
    if (!existing) {
      const res = await gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: { criteria: { from }, action: { addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] } },
      });
      filterId = res.data.id;
    }
    let trashedCount = 0;
    if (trashExisting) {
      let ids = [], pageToken;
      do {
        const r = await gmail.users.messages.list({ userId: 'me', q: 'from:' + from + ' -in:trash', maxResults: 500, pageToken });
        ids = ids.concat((r.data.messages || []).map((m) => m.id));
        pageToken = r.data.nextPageToken;
      } while (pageToken && ids.length < 2000);
      for (let i = 0; i < ids.length; i += 50) {
        await Promise.all(ids.slice(i, i + 50).map((id) => gmail.users.messages.trash({ userId: 'me', id })));
      }
      trashedCount = ids.length;
    }
    return { status: 'ok', filterId, alreadyBlocked: !!existing, trashedCount };
  } catch (err) {
    const detail = (err.response && err.response.data) || err.errors || null;
    return { status: 'error', message: err.message, code: err.code, detail: detail ? JSON.stringify(detail) : undefined };
  }
}

async function listBlockedSenders(p) {
  const email = (p.email || '').trim();
  if (!email) return { status: 'error', message: '필수 파라미터 누락(email)' };
  const gmail = gmailClientFor(email);
  try {
    const res = await gmail.users.settings.filters.list({ userId: 'me' });
    const items = (res.data.filter || []).filter(isBlockFilter).map((fl) => ({ id: fl.id, from: fl.criteria.from }));
    items.sort((a, b) => a.from.localeCompare(b.from));
    return { status: 'ok', items };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function unblockSender(p) {
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
  const ALLOWED_SHARED = ['info@jibokdeukmaru.com', 'sales@jibokdeukmaru.com', 'rnd@jibokdeukmaru.com', 'office@jibokdeukmaru.com'];
  const fromAddr = (fromInput && (fromInput === senderEmail || ALLOWED_SHARED.indexOf(fromInput) !== -1)) ? fromInput : senderEmail;
  if (!fromAddr || !senderEmail) return { status: 'error', message: '발신자 정보가 없습니다.' };

  const senderName = (p.senderName || '').trim();
  const senderTitle = (p.senderTitle || '').trim();
  const senderCardUrl = (p.senderCardUrl || '').trim();

  const signature = senderCardUrl ? (
    '<table style="margin-top:32px;padding-top:20px;border-top:2px solid #E5D9C6;border-collapse:collapse;"><tr><td style="vertical-align:top;">' +
    '<img src="' + senderCardUrl + '" alt="서명" style="display:block;max-width:420px;width:100%;height:auto;">' +
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
  // ★ (2026-09-30) 답장 스레드 연결 — In-Reply-To/References 헤더(+ 아래 threadId)가 있어야 받는 쪽에서도 같은 대화로 묶인다.
  //   헤더 주입 방지를 위해 줄바꿈 제거.
  const inReplyTo = String(p.inReplyTo || '').replace(/[\r\n]+/g, ' ').trim();
  const references = String(p.references || '').replace(/[\r\n]+/g, ' ').trim();
  const threadId = String(p.threadId || '').trim();
  if (inReplyTo) headerLines.push('In-Reply-To: ' + inReplyTo);
  if (references) headerLines.push('References: ' + references);
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

  // ★ info@/sales@/rnd@는 실제 로그인 가능한 Gmail 사용자 계정이 아니라 구글 그룹이라,
  //   서비스계정이 그 주소 자체로 도메인 위임(impersonate)을 시도하면 "unauthorized_client"
  //   에러가 난다(그룹은 도메인 위임 대상이 될 수 없음 — 실제 사용자 계정만 가능).
  //   대신 항상 "실제로 로그인한 직원 본인" 메일함으로 위임해서 보내고, From 헤더만 공유주소로
  //   지정한다. 해당 그룹에 "회원이 그룹으로 게시(전송)하도록 허용"이 켜져 있어야 Gmail이 이
  //   From을 그대로 인정한다(꺼져있으면 Gmail이 본인 주소로 되돌리거나 거부할 수 있음).
  const gmail = gmailClientFor(senderEmail);
  try {
    try {
      await gmail.users.messages.send({ userId: 'me', requestBody: threadId ? { raw: rawEncoded, threadId } : { raw: rawEncoded } });
    } catch (e) {
      // 스레드 ID가 이 메일함 것이 아니면(공유주소 등) Gmail이 거부할 수 있다 — 스레드 없이 한 번 더 보낸다
      if (!threadId) throw e;
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw: rawEncoded } });
    }
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', message: (err.errors && err.errors[0] && err.errors[0].message) || err.message };
  }
}

// ★ (2026-09-30 보안) 예전엔 공유 비밀키(_appKey)만 맞으면 요청에 적힌 아무 직원의 메일함이나 열어줬다.
//   그 키는 웹페이지 소스에 그대로 들어있어 누구나 볼 수 있으므로, 이제는 ERP 로그인 때 발급되는
//   Firebase 로그인 토큰(_idToken)을 검증해서 "로그인한 직원 본인 메일함"만 허용한다.
//   토큰의 email 클레임(auth-api가 발급 시 넣음)을 쓰고, 없으면 employees/{uid}에서 조회한다.
// 같은 토큰으로 연달아 오는 요청(목록→본문→읽음처리 등)은 검증 결과를 재사용(토큰 만료 시각까지, 최대 10분)
const _callerCache = new Map(); // idToken -> { email, until }
const _uidEmailCache = new Map(); // uid -> { email, until }
async function resolveCallerEmail(params, req) {
  const authHeader = String((req.get && req.get('Authorization')) || '');
  const idToken = String(params._idToken || '').trim() || (authHeader.indexOf('Bearer ') === 0 ? authHeader.slice(7) : '');
  if (!idToken) return { error: '로그인 정보가 없습니다. 페이지를 새로고침(Ctrl+F5)한 뒤 다시 시도해 주세요.' };
  const hit = _callerCache.get(idToken);
  if (hit && hit.until > Date.now()) return { email: hit.email, mailbox: hit.mailbox };
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { error: '로그인 정보가 만료되었거나 올바르지 않습니다. 로그아웃 후 다시 로그인해 주세요.' };
  }
  let email = String(decoded.email || '').trim().toLowerCase();
  // ★ (2026-10-02) 공용 메일함 지정(employees/{uid}.mailbox) — 개인 구글 계정이 없는 직원이 관리자가
  //   지정한 공용 메일함(예: office@)을 대신 연다. 지정은 관리자만 바꿀 수 있고(auth-api, 회사 도메인만),
  //   바꾼 뒤 최대 5분 안에 반영된다.
  let mailbox = '';
  if (decoded.uid) {
    const u = _uidEmailCache.get(decoded.uid);
    if (u && u.until > Date.now()) { email = email || u.email; mailbox = u.mailbox; }
    else {
      try {
        const snap = await admin.firestore().collection('employees').doc(decoded.uid).get();
        const d = (snap.exists && snap.data()) || {};
        const empEmail = String(d.email || '').trim().toLowerCase();
        mailbox = String(d.mailbox || '').trim().toLowerCase();
        email = email || empEmail;
        _uidEmailCache.set(decoded.uid, { email: empEmail, mailbox, until: Date.now() + 5 * 60 * 1000 });
      } catch (e) { /* 조회 실패 시 토큰 email만으로 진행(아래에서 없으면 거부) */ }
    }
  }
  if (!email && !mailbox) return { error: '직원 계정으로 로그인되어 있지 않습니다. 로그아웃 후 다시 로그인해 주세요.' };
  if (_callerCache.size > 500) _callerCache.clear();
  _callerCache.set(idToken, { email, mailbox, until: Math.min(decoded.exp * 1000, Date.now() + 5 * 60 * 1000) });
  return { email, mailbox };
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
  const caller = await resolveCallerEmail(params, req);
  if (caller.error) return res.status(401).json({ status: 'error', message: caller.error });
  // 모든 기능은 params.email(조회/수정할 메일함), 발송은 senderEmail(보내는 사람 본인 계정)을 쓴다 — 둘 다 로그인한 본인이어야 함
  const target = String((action === 'sendEmailFromERP' ? params.senderEmail : params.email) || '').trim().toLowerCase();
  if (!target || (target !== caller.email && target !== caller.mailbox)) {
    return res.status(403).json({ status: 'error', message: '본인 메일함(또는 지정된 공용 메일함)에만 접근할 수 있습니다.' });
  }
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
      case 'createGmailFilter': result = await createGmailFilter(params); break;
      case 'blockSender': result = await blockSender(params); break;
      case 'listBlockedSenders': result = await listBlockedSenders(params); break;
      case 'unblockSender': result = await unblockSender(params); break;
      default: result = { status: 'error', message: '알 수 없는 action: ' + action };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
};
