// HTTP-triggered Cloud Function (call daily via Cloud Scheduler, 매일 20:00 KST 권장):
// 쇼룸상담(consults)과 재고현황(stockBetaLots/stockExtraLots) Firestore 데이터를 통째로
// CSV로 떠서 구글드라이브 백업 폴더에 올린다. 데이터 유실 대비용 안전망이라, 화면용으로
// 가공된 컬럼(downloadConsultCSV 등)이 아니라 Firestore 원본 필드를 빠짐없이 담는다.
// 폴더 공유: GMAIL_SA_EMAIL 서비스계정 이메일을 백업용 드라이브 폴더에 "편집자"로
// 공유해두면, 도메인 위임 없이 이 서비스계정 자신의 신원으로 그 폴더에 파일을 만들 수 있다.
const { google } = require('googleapis');
const { Firestore } = require('@google-cloud/firestore');

const PROJECT_ID = 'jibokdeukmaru-erp-504904';
const firestore = new Firestore({ projectId: PROJECT_ID });

const SA_EMAIL = process.env.GMAIL_SA_EMAIL;
const SA_KEY = (process.env.GMAIL_SA_KEY || '').replace(/\\n/g, '\n');
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const DRIVE_FOLDER_ID = process.env.DRIVE_BACKUP_FOLDER_ID;
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '7', 10);

function driveClient() {
  // subject 없음 = 실제 직원을 사칭(impersonate)하는 게 아니라 서비스계정 "본인" 신원으로
  // 접근 — 폴더를 이 서비스계정 이메일에 직접 공유해뒀기 때문에 도메인 위임이 필요 없다.
  const jwt = new google.auth.JWT({
    email: SA_EMAIL,
    key: SA_KEY,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth: jwt });
}

function todayKst() {
  // 서버 기본 타임존(UTC)과 무관하게 KST 기준 YYYY-MM-DD ('sv-SE' 로케일이 ISO 형식으로 나옴)
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function csvValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v.toDate === 'function') return v.toDate().toISOString(); // Firestore Timestamp
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function escapeCsv(val) {
  let v = val != null ? String(val) : '';
  v = v.replace(/"/g, '""');
  if (v.includes(',') || v.includes('"') || v.includes('\n')) v = `"${v}"`;
  return v;
}

// rows: [{ id, ...fields }, ...] — 문서마다 필드 구성이 달라도(재고 LOT 등) 전체 문서의
// 필드를 합집합으로 모아 컬럼을 만든다. 순서는 id 다음 알파벳순(결정적이어야 재현 가능).
function buildCsv(rows) {
  const keySet = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => { if (k !== 'id') keySet.add(k); }));
  const keys = ['id', ...Array.from(keySet).sort()];
  const lines = [keys.map(escapeCsv).join(',')];
  rows.forEach(r => {
    lines.push(keys.map(k => escapeCsv(csvValue(r[k]))).join(','));
  });
  return '﻿' + lines.join('\n'); // BOM: 엑셀 한글 깨짐 방지
}

async function fetchCollection(name) {
  const snap = await firestore.collection(name).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function uploadCsv(drive, filename, csvText) {
  // 서비스계정은 자체 저장용량이 0이라 "내 드라이브" 폴더엔 못 올린다(GaxiosError:
  // "Service Accounts do not have storage quota") — 반드시 공유 드라이브(Shared Drive)
  // 안의 폴더여야 하고, supportsAllDrives를 켜야 공유 드라이브 항목을 다룰 수 있다.
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [DRIVE_FOLDER_ID], mimeType: 'text/csv' },
    media: { mimeType: 'text/csv', body: csvText },
    fields: 'id,name',
    supportsAllDrives: true,
  });
  return res.data;
}

async function cleanupOldBackups(drive) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const res = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id,name,createdTime)',
    pageSize: 1000,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });
  const files = res.data.files || [];
  let deleted = 0;
  for (const f of files) {
    const created = new Date(f.createdTime).getTime();
    if (created < cutoff) {
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

exports.dailyBackup = async (req, res) => {
  const key = (req.query && req.query._appKey) || (req.body && req.body._appKey);
  if (key !== INTERNAL_KEY) {
    return res.status(403).json({ status: 'error', message: '인증 실패' });
  }
  if (!DRIVE_FOLDER_ID) {
    return res.status(500).json({ status: 'error', message: 'DRIVE_BACKUP_FOLDER_ID 환경변수 누락' });
  }
  try {
    const date = todayKst();
    const drive = driveClient();

    const consults = await fetchCollection('consults');
    const stockLots = (await fetchCollection('stockBetaLots')).map(r => ({ ...r, _source: 'stockBetaLots' }));
    const extraLots = (await fetchCollection('stockExtraLots')).map(r => ({ ...r, _source: 'stockExtraLots' }));

    const consultCsv = buildCsv(consults);
    const stockCsv = buildCsv([...stockLots, ...extraLots]);

    const uploaded = [];
    uploaded.push(await uploadCsv(drive, `쇼룸상담_${date}.csv`, consultCsv));
    uploaded.push(await uploadCsv(drive, `재고현황_${date}.csv`, stockCsv));

    const deleted = await cleanupOldBackups(drive);

    res.json({
      status: 'ok',
      date,
      counts: { consults: consults.length, stockBetaLots: stockLots.length, stockExtraLots: extraLots.length },
      uploaded: uploaded.map(f => f.name),
      deletedOldBackups: deleted,
    });
  } catch (e) {
    console.error('일일 백업 실패:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
};
