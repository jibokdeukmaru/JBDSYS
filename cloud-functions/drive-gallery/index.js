// HTTP-triggered Cloud Function: ERP "이미지 갤러리" 탭에서 구글드라이브(공유 드라이브)에
// 있는 제품 사진 폴더트리를 읽기 전용으로 보여주기 위한 프록시. 기존 Gmail 연동용
// 서비스계정(GMAIL_SA_EMAIL/GMAIL_SA_KEY, daily-backup/auth-api와 동일)을 그대로 재사용
// 하며, 새로 API/서비스계정을 만들지 않는다 — 대상 최상위 폴더를 이 서비스계정 이메일에
// "뷰어"로 공유해두기만 하면 된다(daily-backup의 "편집자" 공유와 같은 방식, 권한만 낮음).
// ★ package.json이 "type":"module"(Cloud Run "함수 작성" 콘솔 기본 템플릿)이라 ESM
//   import/export + functions-framework의 명시적 registration(functions.http)을 쓴다.
import functions from '@google-cloud/functions-framework';
import { google } from 'googleapis';

const SA_EMAIL = process.env.GMAIL_SA_EMAIL;
const SA_KEY = (process.env.GMAIL_SA_KEY || '').replace(/\\n/g, '\n');
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
// 갤러리로 노출할 최상위 폴더(바람시리즈) — 임의의 folderId/fileId로 이 함수를 호출해서
// 드라이브의 다른 폴더를 훑어보는 걸 막기 위해, 매 요청마다 이 루트 밑인지 확인한다.
const ROOT_FOLDER_ID = process.env.GALLERY_ROOT_FOLDER_ID;

function driveClient() {
  const jwt = new google.auth.JWT({
    email: SA_EMAIL,
    key: SA_KEY,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth: jwt });
}

const IMAGE_MIME_PREFIX = 'image/';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// 같은 함수 인스턴스가 재사용되는 동안(콜드스타트가 아닌 요청) 이미 루트 하위로 확인된
// 폴더 id를 기억해두는 캐시. Drive API files.get() 왕복이 건당 수백ms라, 트리를 깊이
// 내려갈수록 아래 isWithinRoot의 부모 체인 순차 조회가 그대로 클릭 반응 지연으로 이어지던
// 게 "트리가 느리다"는 체감의 주 원인이었다 — 한 번 확인된 폴더는 API 호출 없이 즉시 통과.
const verifiedWithinRoot = new Set([ROOT_FOLDER_ID]);

// folderId(또는 fileId)가 ROOT_FOLDER_ID 자신이거나 그 하위(임의 깊이)에 있는지, 부모 체인을
// 따라 올라가며 확인한다. 깊이 제한(20단계)은 무한루프 방지용 안전장치.
async function isWithinRoot(drive, id) {
  if (verifiedWithinRoot.has(id)) return true;
  const chain = [id];
  let current = id;
  for (let i = 0; i < 20; i++) {
    let meta;
    try {
      meta = await drive.files.get({ fileId: current, fields: 'id,parents', supportsAllDrives: true });
    } catch (e) {
      return false;
    }
    const parents = meta.data.parents || [];
    const parent = parents[0];
    if (parents.includes(ROOT_FOLDER_ID) || (parent && verifiedWithinRoot.has(parent))) {
      chain.forEach(c => verifiedWithinRoot.add(c));
      return true;
    }
    if (!parents.length) return false;
    current = parent;
    chain.push(current);
  }
  return false;
}

async function listFolder(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType)',
    pageSize: 1000,
    orderBy: 'name_natural',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });
  const files = res.data.files || [];
  const folders = files.filter(f => f.mimeType === FOLDER_MIME).map(f => ({ id: f.id, name: f.name }));
  const images = files.filter(f => f.mimeType && f.mimeType.startsWith(IMAGE_MIME_PREFIX)).map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType }));
  // folderId는 호출 시점에 이미 루트 하위로 확인된 상태이므로, 그 직속 하위 폴더들도
  // 전부 루트 하위임이 자동으로 보장된다 — 다음에 이 하위 폴더를 클릭할 때 isWithinRoot가
  // 부모 체인을 다시 훑지 않고 캐시로 즉시 통과하도록 미리 등록해둔다.
  folders.forEach(f => verifiedWithinRoot.add(f.id));
  return { folders, images };
}

functions.http('driveGallery', async (req, res) => {
  // ★ ERP 페이지(sys.jibokdeukmaru.com)에서 fetch()로 호출하므로 다른 함수들(auth-api,
  //   leave-api, gmail-api)과 동일하게 CORS 헤더가 필요하다 — 이게 없으면 브라우저 URL
  //   직접 접속(=top-level navigation)은 되는데 fetch()만 조용히 막혀서 "됐다가 안 되는"
  //   것처럼 보인다.
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const key = (req.query && req.query._appKey) || (req.body && req.body._appKey);
  if (key !== INTERNAL_KEY) {
    return res.status(403).json({ status: 'error', message: '인증 실패' });
  }
  if (!ROOT_FOLDER_ID) {
    return res.status(500).json({ status: 'error', message: 'GALLERY_ROOT_FOLDER_ID 환경변수 누락' });
  }

  const action = req.query.action;
  const drive = driveClient();

  try {
    if (action === 'listFolder') {
      const folderId = req.query.folderId || ROOT_FOLDER_ID;
      if (!(await isWithinRoot(drive, folderId))) {
        return res.status(403).json({ status: 'error', message: '허용되지 않은 폴더입니다' });
      }
      const { folders, images } = await listFolder(drive, folderId);
      // 트리 좌측 최상단 루트 라벨은 프론트에서 이름을 알 방법이 없어서(자신을 가리키는
      // 폴더ID만 상수로 갖고 있음), 루트 폴더 자신의 이름을 함께 내려준다. 프론트는 이
      // 필드를 루트 요청일 때만 실제로 사용하므로, 비루트 폴더에서는 매 클릭마다 이름 조회
      // API를 추가로 태우지 않는다.
      let folderName;
      if (folderId === ROOT_FOLDER_ID) {
        const selfMeta = await drive.files.get({ fileId: folderId, fields: 'name', supportsAllDrives: true });
        folderName = selfMeta.data.name;
      }
      return res.json({ status: 'ok', folderName, folders, images });
    }

    if (action === 'image') {
      const fileId = req.query.fileId;
      if (!fileId) return res.status(400).json({ status: 'error', message: 'fileId 누락' });
      if (!(await isWithinRoot(drive, fileId))) {
        return res.status(403).json({ status: 'error', message: '허용되지 않은 파일입니다' });
      }
      // 프론트는 폴더 목록 조회(listFolder) 때 이미 mimeType을 받아둔 상태라 그대로 넘겨준다 —
      // 예전엔 사진 한 장 볼 때마다 이 메타데이터를 Drive API로 한 번 더 조회해서(스트리밍
      // 요청과 별개로 왕복 1회 추가) 로딩이 그만큼 느려졌다. 안 넘어온 경우(구버전 캐시 등)만
      // 하위호환으로 예전처럼 조회한다.
      // 클라이언트가 주는 값은 신뢰하지 않고 image/* 형태일 때만 사용한다(응답 헤더 스푸핑 방지) —
      // 이상한 값이 오면 그냥 무시하고 예전처럼 서버가 직접 조회한다.
      let contentType = /^image\/[\w.+-]+$/i.test(req.query.mimeType || '') ? req.query.mimeType : null;
      if (!contentType) {
        const meta = await drive.files.get({ fileId, fields: 'mimeType', supportsAllDrives: true });
        contentType = meta.data.mimeType || 'application/octet-stream';
      }
      const stream = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      res.setHeader('Content-Type', contentType);
      // 이미지 자체는 자주 안 바뀌니 브라우저 캐시를 적극적으로 태운다(같은 이미지를 드래그로
      // 왔다갔다 다시 볼 때 매번 재다운로드하지 않도록).
      res.setHeader('Cache-Control', 'private, max-age=86400');
      stream.data.pipe(res);
      return;
    }

    return res.status(400).json({ status: 'error', message: '알 수 없는 action' });
  } catch (e) {
    console.error('드라이브 갤러리 조회 실패:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});
