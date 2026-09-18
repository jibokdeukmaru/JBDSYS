// HTTP-triggered Cloud Function: ERP "이미지 갤러리" 탭에서 구글드라이브(공유 드라이브)에
// 있는 제품 사진 폴더트리를 읽기 전용으로 보여주기 위한 프록시. 기존 Gmail 연동용
// 서비스계정(GMAIL_SA_EMAIL/GMAIL_SA_KEY, daily-backup/auth-api와 동일)을 그대로 재사용
// 하며, 새로 API/서비스계정을 만들지 않는다 — 대상 최상위 폴더를 이 서비스계정 이메일에
// "뷰어"로 공유해두기만 하면 된다(daily-backup의 "편집자" 공유와 같은 방식, 권한만 낮음).
const { google } = require('googleapis');

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

// folderId(또는 fileId)가 ROOT_FOLDER_ID 자신이거나 그 하위(임의 깊이)에 있는지, 부모 체인을
// 따라 올라가며 확인한다. 깊이 제한(20단계)은 무한루프 방지용 안전장치.
async function isWithinRoot(drive, id) {
  if (id === ROOT_FOLDER_ID) return true;
  let current = id;
  for (let i = 0; i < 20; i++) {
    let meta;
    try {
      meta = await drive.files.get({ fileId: current, fields: 'id,parents', supportsAllDrives: true });
    } catch (e) {
      return false;
    }
    const parents = meta.data.parents || [];
    if (parents.includes(ROOT_FOLDER_ID)) return true;
    if (!parents.length) return false;
    current = parents[0];
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
  return { folders, images };
}

exports.driveGallery = async (req, res) => {
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
      // 폴더ID만 상수로 갖고 있음), 요청한 폴더 자신의 이름도 함께 내려준다.
      const selfMeta = await drive.files.get({ fileId: folderId, fields: 'name', supportsAllDrives: true });
      return res.json({ status: 'ok', folderName: selfMeta.data.name, folders, images });
    }

    if (action === 'image') {
      const fileId = req.query.fileId;
      if (!fileId) return res.status(400).json({ status: 'error', message: 'fileId 누락' });
      if (!(await isWithinRoot(drive, fileId))) {
        return res.status(403).json({ status: 'error', message: '허용되지 않은 파일입니다' });
      }
      const meta = await drive.files.get({ fileId, fields: 'mimeType,name', supportsAllDrives: true });
      const stream = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      res.setHeader('Content-Type', meta.data.mimeType || 'application/octet-stream');
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
};
