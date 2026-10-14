// HTTP-triggered Cloud Function — 지복득마루ERP 전체 백업/복구.
//
// ① 백업 (Cloud Scheduler가 매일 20:00 KST에 GET ?_appKey=... 로 호출):
//    Firestore의 모든 최상위 컬렉션(직원정보·로그인 비밀번호 해시·연차/휴가·개인달력·쇼룸상담·
//    재고현황·시공일정·예약 등 ERP가 쓰는 데이터 전부)을 하나도 빠짐없이 읽어서, 값의 형식(숫자/
//    날짜/참거짓 등)까지 그대로 보존한 JSON을 gzip으로 압축해 구글드라이브 백업 폴더에
//    "지복득마루ERP_백업데이터_날짜_시각.json.gz" 파일 하나로 올린다. 사람이 열어보는 용도가 아니라
//    복구 전용 파일이다. 매 실행마다 폴더 안에서 생성된 지 BACKUP_RETENTION_DAYS(기본 7)일 지난
//    파일은 자동 삭제. 컬렉션 목록을 코드에 적어두지 않고 매번 Firestore에서 직접 조회하므로,
//    나중에 ERP에 새 기능(새 컬렉션)이 생겨도 자동으로 백업에 포함된다.
//
// ② 복구 (ERP 관리자페이지 → 데이터베이스 관리 → 백업 데이터 복구에서 POST로 호출):
//    - 평소: ERP 로그인 토큰(_idToken)을 검증하고, employees/{uid}의 최신 role이 admin인 경우만 허용.
//    - 긴급: Firestore가 통째로 날아가면 직원 정보가 없어서 로그인 자체가 안 되므로, 로그인 화면의
//      "긴급 데이터 복구"에서 복구키(_restoreKey = 환경변수 RESTORE_KEY)로도 허용한다.
//      ★ _appKey(INTERNAL_API_KEY)는 ERP 웹페이지 소스에 공개돼 있어서 복구 권한으로는 절대 쓰지 않는다.
//    복구 = 선택한 컬렉션을 백업 시점 상태로 "그대로" 되돌린다: 백업에 있는 문서는 통째로 덮어쓰고,
//    백업 이후 새로 생긴 문서는 삭제한다. 복구 직전에는 현재 상태를 자동으로 한 번 더 백업해 둔다
//    (잘못 복구했을 때 그 파일로 되돌릴 수 있게).
//
// 서비스계정(GMAIL_SA_EMAIL)은 자체 저장용량이 0이라 반드시 "공유 드라이브" 안의 폴더를
// DRIVE_BACKUP_FOLDER_ID로 써야 한다(일반 "내 드라이브" 폴더면 storage quota 에러).
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const { google } = require('googleapis');
const admin = require('firebase-admin');

const PROJECT_ID = 'jibokdeukmaru-erp-504904';
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { Timestamp, GeoPoint, DocumentReference } = admin.firestore;

const SA_EMAIL = process.env.GMAIL_SA_EMAIL;
const SA_KEY = (process.env.GMAIL_SA_KEY || '').replace(/\\n/g, '\n');
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const RESTORE_KEY = String(process.env.RESTORE_KEY || '').trim();
const DRIVE_FOLDER_ID = process.env.DRIVE_BACKUP_FOLDER_ID;
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '7', 10);

const BACKUP_FORMAT = 'jbd-erp-backup';
const BACKUP_PREFIX = '지복득마루ERP_백업데이터_';

function driveClient() {
  // subject 없음 = 실제 직원을 사칭(impersonate)하는 게 아니라 서비스계정 "본인" 신원으로 접근.
  const jwt = new google.auth.JWT({
    email: SA_EMAIL,
    key: SA_KEY,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth: jwt });
}

function kstStamp(ms) {
  // 서버 기본 타임존(UTC)과 무관하게 KST 기준 'YYYY-MM-DD_HHmm'
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

// ── 값 형식 보존 인코딩 ──
// JSON에는 Firestore Timestamp/GeoPoint/문서참조/바이너리가 없어서, {"__t": 종류, "v": 값}으로 감싸서
// 저장하고 복구 때 원래 형식으로 되돌린다. 원래 데이터에 우연히 "__t" 키가 있는 객체는 obj로 한 번 더
// 감싸서 헷갈리지 않게 한다.
function enc(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : { __t: 'num', v: String(v) };
  if (typeof v !== 'object') return v;
  if (v instanceof Timestamp) return { __t: 'ts', v: [v.seconds, v.nanoseconds] };
  if (v instanceof Date) return { __t: 'ts', v: [Math.floor(v.getTime() / 1000), (v.getTime() % 1000) * 1e6] };
  if (v instanceof GeoPoint) return { __t: 'geo', v: [v.latitude, v.longitude] };
  if (v instanceof DocumentReference) return { __t: 'ref', v: v.path };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __t: 'bytes', v: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(enc);
  const out = {};
  for (const k of Object.keys(v)) out[k] = enc(v[k]);
  return Object.prototype.hasOwnProperty.call(v, '__t') ? { __t: 'obj', v: out } : out;
}
function dec(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(dec);
  if (typeof v.__t === 'string' && Object.keys(v).length === 2 && 'v' in v) {
    switch (v.__t) {
      case 'ts': return new Timestamp(v.v[0], v.v[1]);
      case 'geo': return new GeoPoint(v.v[0], v.v[1]);
      case 'ref': return db.doc(v.v);
      case 'bytes': return Buffer.from(v.v, 'base64');
      case 'num': return Number(v.v);
      case 'obj': { const o = {}; for (const k of Object.keys(v.v)) o[k] = dec(v.v[k]); return o; }
    }
  }
  const out = {};
  for (const k of Object.keys(v)) out[k] = dec(v[k]);
  return out;
}

// ── 백업 ──
async function buildBackup() {
  const backupAt = Date.now();
  const cols = await db.listCollections();
  const collections = {};
  for (const col of cols) {
    const snap = await col.get();
    collections[col.id] = snap.docs.map(d => [d.id, enc(d.data())]);
  }
  return { format: BACKUP_FORMAT, version: 1, projectId: PROJECT_ID, backupAt, collections };
}

async function uploadBackup(drive, backup, tag) {
  const name = `${BACKUP_PREFIX}${kstStamp(backup.backupAt)}${tag ? '_' + tag : ''}.json.gz`;
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(backup), 'utf8'));
  const res = await drive.files.create({
    requestBody: { name, parents: [DRIVE_FOLDER_ID], mimeType: 'application/gzip' },
    media: { mimeType: 'application/gzip', body: Readable.from(body) },
    fields: 'id,name,size',
    supportsAllDrives: true,
  });
  return res.data;
}

async function listFolder(drive) {
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name,createdTime,size)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function cleanupOldBackups(drive) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = await listFolder(drive);
  let deleted = 0;
  for (const f of files) {
    if (new Date(f.createdTime).getTime() < cutoff) {
      try {
        await drive.files.delete({ fileId: f.id, supportsAllDrives: true });
        deleted++;
      } catch (e) {
        console.error('백업 파일 삭제 실패:', f.name, e.message);
      }
    }
  }
  return deleted;
}

async function runBackup(tag) {
  const drive = driveClient();
  const backup = await buildBackup();
  const file = await uploadBackup(drive, backup, tag);
  const deleted = await cleanupOldBackups(drive);
  const counts = {};
  Object.keys(backup.collections).forEach(c => { counts[c] = backup.collections[c].length; });
  return { file: file.name, size: Number(file.size) || 0, backupAt: backup.backupAt, counts, deletedOldBackups: deleted };
}

// ── 복구 ──
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

async function authorizeRestore(params) {
  if (params._restoreKey) {
    if (RESTORE_KEY && safeEqual(String(params._restoreKey).trim(), RESTORE_KEY)) return { ok: true, who: '긴급 복구키' };
    return { ok: false, message: RESTORE_KEY ? '복구키가 올바르지 않습니다.' : '긴급 복구키가 아직 설정되지 않았습니다(RESTORE_KEY).' };
  }
  const idToken = String(params._idToken || '').trim();
  if (!idToken) return { ok: false, message: '로그인 정보가 없습니다. 다시 로그인해 주세요.' };
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const snap = await db.collection('employees').doc(String(decoded.uid)).get();
    const emp = (snap.exists && snap.data()) || {};
    if (emp.role !== 'admin') return { ok: false, message: '관리자만 복구할 수 있습니다.' };
    if (emp.leaveDate && String(emp.leaveDate) <= new Date().toISOString().slice(0, 10)) return { ok: false, message: '권한이 없습니다.' };
    return { ok: true, who: `${emp.name || ''}(${decoded.uid})` };
  } catch (e) {
    return { ok: false, message: '로그인 정보가 만료되었거나 올바르지 않습니다. 다시 로그인해 주세요.' };
  }
}

function parseBackupBuffer(buf) {
  const raw = (buf[0] === 0x1f && buf[1] === 0x8b) ? zlib.gunzipSync(buf) : buf;
  const obj = JSON.parse(raw.toString('utf8'));
  if (!obj || obj.format !== BACKUP_FORMAT || !obj.collections) throw new Error('지복득마루ERP 백업 파일 형식이 아닙니다.');
  return obj;
}

// 같은 인스턴스로 컬렉션별 복구 요청이 연달아 오므로, 방금 내려받은 백업 파일을 잠깐 재사용한다.
let _fileCache = null; // { fileId, until, backup }
async function loadBackupFromDrive(fileId) {
  if (_fileCache && _fileCache.fileId === fileId && _fileCache.until > Date.now()) return _fileCache.backup;
  const drive = driveClient();
  const meta = await drive.files.get({ fileId, fields: 'id,name,parents', supportsAllDrives: true });
  if (!(meta.data.parents || []).includes(DRIVE_FOLDER_ID)) throw new Error('백업 폴더의 파일이 아닙니다.');
  const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  const backup = parseBackupBuffer(Buffer.from(res.data));
  _fileCache = { fileId, until: Date.now() + 10 * 60 * 1000, backup };
  return backup;
}

async function currentCounts(names) {
  const out = {};
  for (const n of names) {
    try { out[n] = (await db.collection(n).count().get()).data().count; } catch (e) { out[n] = null; }
  }
  return out;
}

function checkCollectionName(name) {
  if (typeof name !== 'string' || !name || name.length > 1500 || name.includes('/') || /^__.*__$/.test(name)) {
    throw new Error('잘못된 데이터 이름: ' + name);
  }
}

async function writeDocs(collection, docs) {
  checkCollectionName(collection);
  const writer = db.bulkWriter();
  let failed = 0;
  writer.onWriteError(err => {
    if (err.failedAttempts < 5) return true;
    failed++;
    console.error('복구 쓰기 실패:', err.documentRef.path, err.message);
    return false;
  });
  const col = db.collection(collection);
  for (const [id, data] of docs) writer.set(col.doc(String(id)), dec(data) || {});
  await writer.close();
  return { written: docs.length - failed, failed };
}

async function pruneCollection(collection, keepIds) {
  checkCollectionName(collection);
  const keep = new Set((keepIds || []).map(String));
  const refs = await db.collection(collection).listDocuments();
  const writer = db.bulkWriter();
  let deleted = 0;
  for (const ref of refs) {
    if (!keep.has(ref.id)) { writer.delete(ref); deleted++; }
  }
  await writer.close();
  return { deleted };
}

async function afterRestore(collection) {
  // 재고현황을 열어둔 직원 화면에 "새 변경사항 있음" 배너가 뜨도록 마지막 수정 시각을 갱신.
  if (collection === 'stockBetaLots' || collection === 'stockExtraLots' || collection === 'stockBetaMeta') {
    await db.collection('stockBetaMeta').doc('lastUpdated').set({ ts: Date.now() }, { merge: true });
  }
}

async function handleRestoreAction(params) {
  const action = params.action;
  if (action === 'list') {
    const files = (await listFolder(driveClient()))
      .filter(f => f.name.indexOf(BACKUP_PREFIX) === 0)
      .sort((a, b) => (a.createdTime < b.createdTime ? 1 : -1))
      .map(f => ({ id: f.id, name: f.name, createdTime: f.createdTime, size: Number(f.size) || 0 }));
    return { files };
  }
  if (action === 'inspect') {
    const backup = await loadBackupFromDrive(String(params.fileId || ''));
    const counts = {};
    Object.keys(backup.collections).forEach(c => { counts[c] = backup.collections[c].length; });
    return { backupAt: backup.backupAt, counts, current: await currentCounts(Object.keys(counts)) };
  }
  if (action === 'counts') {
    const names = (params.collections || []).map(String);
    names.forEach(checkCollectionName);
    return { current: await currentCounts(names) };
  }
  if (action === 'preRestoreBackup') {
    const r = await runBackup('복구직전');
    return { file: r.file };
  }
  if (action === 'restoreCollection') {
    const collection = String(params.collection || '');
    const backup = await loadBackupFromDrive(String(params.fileId || ''));
    const docs = backup.collections[collection];
    if (!docs) throw new Error('백업에 없는 데이터입니다: ' + collection);
    const w = await writeDocs(collection, docs);
    const p = await pruneCollection(collection, docs.map(d => d[0]));
    await afterRestore(collection);
    return Object.assign({ collection }, w, p);
  }
  // PC에 있는 백업 파일을 올려서 복구하는 경우 — 브라우저가 파일을 풀어서 문서를 나눠 보낸 뒤,
  // 마지막에 prune으로 백업 이후 생긴 문서를 지운다.
  if (action === 'writeDocs') {
    return await writeDocs(String(params.collection || ''), params.docs || []);
  }
  if (action === 'prune') {
    const collection = String(params.collection || '');
    const r = await pruneCollection(collection, params.keepIds || []);
    await afterRestore(collection);
    return r;
  }
  throw new Error('알 수 없는 요청: ' + action);
}

function readParams(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  return Object.assign({}, req.query || {}, body || {});
}

exports.dailyBackup = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  if (!DRIVE_FOLDER_ID) {
    return res.status(500).json({ status: 'error', message: 'DRIVE_BACKUP_FOLDER_ID 환경변수 누락' });
  }
  const params = readParams(req);

  // 복구/조회 요청 (관리자 로그인 또는 긴급 복구키)
  if (params.action) {
    const auth = await authorizeRestore(params);
    if (!auth.ok) return res.status(403).json({ status: 'error', message: auth.message });
    try {
      if (!['list', 'counts', 'inspect'].includes(params.action)) {
        console.log('[복구]', params.action, params.collection || params.fileId || '', 'by', auth.who);
      }
      const result = await handleRestoreAction(params);
      return res.json(Object.assign({ status: 'ok' }, result));
    } catch (e) {
      console.error('복구 요청 실패:', params.action, e);
      return res.status(500).json({ status: 'error', message: e.message });
    }
  }

  // 일일 백업 (Cloud Scheduler)
  if (params._appKey !== INTERNAL_KEY) {
    return res.status(403).json({ status: 'error', message: '인증 실패' });
  }
  try {
    const r = await runBackup('');
    res.json(Object.assign({ status: 'ok' }, r));
  } catch (e) {
    console.error('일일 백업 실패:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
};
