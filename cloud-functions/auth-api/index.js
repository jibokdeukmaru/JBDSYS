// HTTP-triggered Cloud Function: 로그인 검증 + Firebase 커스텀 토큰 발급.
//
// ★ 배경(2026-09-14 개정): 처음엔 비밀번호 검증을 RESERVE스크립트(reserve-script)의
//   loginUser에 위임해 구글시트를 직접 확인했다. 이제는 그마저도 없애고, Admin SDK로
//   Firestore authSecrets/{id} 문서(해시)와 employees/{id} 문서(나머지 프로필)를 직접
//   읽어 이 함수 안에서 검증한다 — 로그인 시점에 구글시트를 아예 안 봄.
//   authSecrets는 firestore.rules에 선언돼있지 않아 기본 차단(default-deny)이라 클라이언트는
//   절대 못 읽고, Admin SDK(이 함수)만 접근 가능하다. 해시는 여전히 reserve-script의
//   hashPassword(SHA-256 + 고정 salt)와 동일한 방식으로 계산해야 대조가 맞는다 — 비밀번호
//   변경/초기화 함수들이 시트에 쓸 때 authSecrets에도 같이 쓰도록 되어 있다(_syncAuthSecretToFirestore).
//   ★ 클라이언트(index.html doLogin)에는 이 함수 호출 자체가 실패할 때(배포 장애 등)만 쓰는
//   구글시트 기반 폴백 로그인이 별도로 남아있다 — 그건 이 함수와 무관하니 건드리지 않았다.
const admin = require('firebase-admin');
const crypto = require('crypto');
admin.initializeApp();
const db = admin.firestore();

// reserve-script Code.gs의 hashPassword와 반드시 동일해야 한다.
const PW_SALT = 'jibokdeuk_salt_2024';
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + PW_SALT, 'utf8').digest('hex');
}

async function login(p) {
  const id = String(p.id || '').trim();
  const pw = String(p.pw || p.password || '');
  if (!id || !pw) return { status: 'error', message: '아이디/비밀번호를 입력해주세요.' };

  let secretSnap, empSnap;
  try {
    [secretSnap, empSnap] = await Promise.all([
      db.collection('authSecrets').doc(id).get(),
      db.collection('employees').doc(id).get()
    ]);
  } catch (e) {
    return { status: 'error', message: '인증 정보 조회 실패: ' + e.message };
  }

  const storedHash = secretSnap.exists ? (secretSnap.data() || {}).pwHash : null;
  if (!empSnap.exists || !storedHash || storedHash !== hashPassword(pw)) {
    return { status: 'error', message: '아이디 또는 비밀번호가 올바르지 않습니다.' };
  }

  const emp = empSnap.data() || {};
  const user = {
    id, name: emp.name, dept: emp.dept, title: emp.title,
    joinDate: emp.joinDate, leaveDate: emp.leaveDate, annualLeave: emp.annualLeave,
    phone: emp.phone, email: emp.email, allowedTabs: emp.allowedTabs, role: emp.role,
    isManager: !!emp.isManager, isHead: !!emp.isHead, usedLeave: emp.usedLeave,
    approverIds: emp.approverIds, birthday: emp.birthday, cardUrl: emp.cardUrl,
    homeTab: emp.homeTab, team: emp.team,
    stockBetaEditor: !!emp.stockBetaEditor, compatEditor: !!emp.compatEditor, scheduleEditor: !!emp.scheduleEditor,
    leaveManagerEditor: !!emp.leaveManagerEditor,
  };

  const claims = { role: user.role || null, email: user.email || null };
  let token;
  try {
    token = await admin.auth().createCustomToken(id, claims);
  } catch (e) {
    // ★ 흔한 원인: 이 함수의 런타임 서비스계정에 "서비스 계정 토큰 생성자
    //   (Service Account Token Creator)" IAM 역할이 없는 경우. GCP 콘솔 → IAM에서
    //   이 함수의 서비스계정(보통 <프로젝트번호>-compute@developer.gserviceaccount.com)에
    //   그 역할을 자기 자신에게 부여해야 createCustomToken이 동작한다.
    return { status: 'error', message: '인증 토큰 발급 실패: ' + e.message };
  }

  return { status: 'ok', user, token };
}

exports.authApi = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  let bodyObj = req.body;
  if (Buffer.isBuffer(bodyObj)) bodyObj = bodyObj.toString('utf8');
  if (typeof bodyObj === 'string') {
    try { bodyObj = JSON.parse(bodyObj); } catch (e) { bodyObj = {}; }
  }
  // ★ 일부 배포 방식(Cloud Run "함수" 인라인 편집기 경로 등)에서는 body-parser 미들웨어가
  //   안 붙어서 req.body가 비어있을 수 있다 — Functions Framework가 항상 채워주는
  //   req.rawBody(원본 바이트)에서 직접 JSON을 파싱하는 걸로 한 번 더 시도한다.
  if (!bodyObj || typeof bodyObj !== 'object' || Object.keys(bodyObj).length === 0) {
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    if (raw) {
      try { bodyObj = JSON.parse(raw); } catch (e) { bodyObj = {}; }
    }
  }
  const params = Object.assign({}, req.query, bodyObj || {});

  if (String(params._appKey || '').trim() !== String(process.env.INTERNAL_API_KEY || '').trim()) {
    return res.status(403).json({ status: 'error', message: '인증 실패' });
  }

  const action = params.action;
  try {
    let result;
    switch (action) {
      case 'login': result = await login(params); break;
      default: result = { status: 'error', message: '알 수 없는 action: ' + action };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
};
