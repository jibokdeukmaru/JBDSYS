// HTTP-triggered Cloud Function: 로그인 검증 + Firebase 커스텀 토큰 발급 + 직원정보/비밀번호 관리.
//
// ★ 배경(2026-09-14 개정): 처음엔 비밀번호 검증을 RESERVE스크립트(reserve-script)의
//   loginUser에 위임해 구글시트를 직접 확인했다. 이제는 그마저도 없애고, Admin SDK로
//   Firestore authSecrets/{id} 문서(해시)와 employees/{id} 문서(나머지 프로필)를 직접
//   읽어 이 함수 안에서 검증한다 — 로그인 시점에 구글시트를 아예 안 봄.
//   authSecrets는 firestore.rules에 선언돼있지 않아 기본 차단(default-deny)이라 클라이언트는
//   절대 못 읽고, Admin SDK(이 함수)만 접근 가능하다. 해시는 여전히 reserve-script의
//   hashPassword(SHA-256 + 고정 salt)와 동일한 방식으로 계산해야 대조가 맞는다.
//
// ★ 추가(2026-09-22): 직원 등록/수정/비밀번호 변경·초기화·찾기/홈화면설정까지 전부 이 함수로
//   이전 — 구글시트(RESERVE스크립트)를 더 이상 아예 안 본다. firestore.rules가 employees
//   컬렉션의 클라이언트 write를 관리자로만 제한해두어서(직원 본인의 홈화면 설정 등도 막힘),
//   이 함수(Admin SDK, 규칙 우회)를 거치지 않으면 애초에 어떤 직원 필드도 못 바꾼다 — 그래서
//   자기 자신의 홈화면 설정처럼 사소해 보이는 것까지 전부 여기 액션으로 옮겼다.
//   이 함수 하나에 다 몰아둔 이유: employees/authSecrets 둘 다 이미 여기서만 접근 가능한
//   구조라(로그인 때문에), 새 Cloud Function을 또 만들 필요 없이 그대로 재사용.
const admin = require('firebase-admin');
const crypto = require('crypto');
admin.initializeApp();
const db = admin.firestore();

// reserve-script Code.gs의 hashPassword와 반드시 동일해야 한다.
const PW_SALT = 'jibokdeuk_salt_2024';
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + PW_SALT, 'utf8').digest('hex');
}

// 문자발송 Cloud Function (reserve-script sendSmsViaErp와 동일 엔드포인트/파라미터)
const SMS_CF_URL = 'https://sendsms-qk3y5nxsda-du.a.run.app';


// ★ (2026-09-30 보안) 예전엔 이 함수 키(_appKey)만 맞으면 요청에 적힌 아이디/권한을 그대로 믿었다.
//   그 키는 ERP 웹페이지 소스에 공개돼 있어 외부인이 남의 비밀번호 초기화·관리자 승격·휴가 승인 등을
//   할 수 있었다. 이제 ERP 로그인 때 발급된 Firebase 로그인 토큰(_idToken)으로 "요청한 직원"을 확인하고,
//   아이디·권한은 요청값이 아니라 Firestore employees/{uid}의 최신값을 쓴다.
async function getCaller(params, req) {
  const authHeader = String((req.get && req.get('Authorization')) || '');
  const idToken = String(params._idToken || '').trim() || (authHeader.indexOf('Bearer ') === 0 ? authHeader.slice(7) : '');
  if (!idToken) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const snap = await admin.firestore().collection('employees').doc(String(decoded.uid)).get();
    if (!snap.exists) return null; // 익명 로그인 등 직원이 아닌 토큰
    const emp = snap.data() || {};
    if (emp.leaveDate && String(emp.leaveDate) <= new Date().toISOString().slice(0, 10)) return null; // 퇴사자
    return Object.assign({}, emp, { id: String(decoded.uid) });
  } catch (e) {
    return null;
  }
}
const NEED_LOGIN = { status: 'error', message: '로그인 정보를 확인할 수 없습니다. 로그아웃 후 다시 로그인해 주세요.' };
const NO_PERMISSION = { status: 'error', message: '권한이 없습니다.' };

function toBool(v) {
  return v === true || v === 'true';
}

// ★ (2026-10-02) 이메일 탭에서 볼 메일함 — 개인 구글 계정이 없는 직원에게 공용 메일함을 지정.
//   gmail-api가 이 값을 그대로 믿고 메일함을 열어주므로, 회사 도메인 주소만 허용('' = 본인 사내 이메일).
function cleanMailbox(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[a-z0-9._%+-]+@jibokdeukmaru\.com$/.test(s) ? s : '';
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
    leaveManagerEditor: !!emp.leaveManagerEditor, mailbox: emp.mailbox || '',
  };

  const claims = { role: user.role || null, email: user.email || null };
  let token;
  try {
    token = await admin.auth().createCustomToken(id, claims);
  } catch (e) {
    return { status: 'error', message: '인증 토큰 발급 실패: ' + e.message };
  }

  return { status: 'ok', user, token };
}

// ── 직원 추가 (관리자 페이지) ──
async function addEmployee(p) {
  const id = String(p.id || '').trim().toLowerCase();
  if (!id) return { status: 'error', message: '아이디를 입력해주세요.' };
  const ref = db.collection('employees').doc(id);
  const existing = await ref.get();
  if (existing.exists) return { status: 'error', message: '이미 사용 중인 아이디입니다.' };

  const now = new Date().toISOString().slice(0, 10);
  const emp = {
    id, name: p.name || '', dept: p.dept || '', title: p.title || '',
    joinDate: p.joinDate || now, leaveDate: '', annualLeave: 0,
    phone: p.phone || '', email: p.email || '', mailbox: cleanMailbox(p.mailbox),
    allowedTabs: 'ALL', role: 'staff', isManager: false, isHead: false,
    usedLeave: 0, approverIds: '',
    birthday: p.birthday || '', cardUrl: p.cardUrl || '', homeTab: '',
    team: p.team || '',
    stockBetaEditor: false, compatEditor: false, scheduleEditor: false, leaveManagerEditor: false,
    quoteVaultAccess: false, quoteVaultViewAll: false, empStatus: ''
  };
  const hash = hashPassword('0000');
  await Promise.all([
    ref.set(emp),
    db.collection('authSecrets').doc(id).set({ pwHash: hash })
  ]);
  return { status: 'ok' };
}

// ── 직원 기본정보 수정 (이름/부서/직급/입사일/연락처/권한 등 일괄) ──
async function updateEmployeeInfo(p) {
  const id = String(p.id || '').trim();
  if (!id) return { status: 'error', message: '아이디가 없습니다.' };
  const ref = db.collection('employees').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'error', message: '직원을 찾을 수 없습니다.' };

  const upd = {};
  if (p.name) upd.name = p.name;
  if (p.dept) upd.dept = p.dept;
  if (p.title) upd.title = p.title;
  if (p.joinDate) upd.joinDate = p.joinDate;
  if (p.annualLeave !== undefined && p.annualLeave !== '') upd.annualLeave = Number(p.annualLeave) || 0;
  if (p.phone !== undefined) upd.phone = p.phone;
  if (p.email !== undefined) upd.email = p.email;
  if (p.mailbox !== undefined) upd.mailbox = cleanMailbox(p.mailbox);
  if (p.isManager !== undefined) upd.isManager = toBool(p.isManager);
  if (p.isHead !== undefined) upd.isHead = toBool(p.isHead);
  if (p.usedLeave !== undefined && p.usedLeave !== '') upd.usedLeave = Number(p.usedLeave) || 0;
  if (p.approverIds !== undefined) upd.approverIds = p.approverIds;
  if (p.birthday !== undefined && p.birthday !== '') upd.birthday = p.birthday;
  if (p.cardUrl !== undefined) upd.cardUrl = p.cardUrl;
  if (p.team !== undefined) upd.team = p.team;
  if (p.stockBetaEditor !== undefined) upd.stockBetaEditor = toBool(p.stockBetaEditor);
  if (p.compatEditor !== undefined) upd.compatEditor = toBool(p.compatEditor);
  if (p.scheduleEditor !== undefined) upd.scheduleEditor = toBool(p.scheduleEditor);
  if (p.leaveManagerEditor !== undefined) upd.leaveManagerEditor = toBool(p.leaveManagerEditor);
  if (p.quoteVaultAccess !== undefined) upd.quoteVaultAccess = toBool(p.quoteVaultAccess);
  if (p.quoteVaultViewAll !== undefined) upd.quoteVaultViewAll = toBool(p.quoteVaultViewAll);
  if (p.empStatus !== undefined) upd.empStatus = p.empStatus;

  if (Object.keys(upd).length) await ref.update(upd);
  return { status: 'ok' };
}

// ── 직원 허용탭/역할만 바꾸는 가벼운 업데이트 (관리자 목록의 역할 드롭다운/탭권한 모달) ──
async function updateEmployee(p) {
  const id = String(p.id || '').trim();
  if (!id) return { status: 'error', message: '아이디가 없습니다.' };
  const ref = db.collection('employees').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'error', message: '직원을 찾을 수 없습니다: ' + id };

  const upd = {};
  if (p.allowedTabs !== undefined && p.allowedTabs !== null) upd.allowedTabs = p.allowedTabs;
  if (p.role !== undefined && p.role !== null) upd.role = p.role;
  if (Object.keys(upd).length) await ref.update(upd);
  return { status: 'ok', firestoreSynced: true };
}

// ── 퇴직 처리(leaveDate 설정, empStatus를 resigned/재직중으로 함께 맞춤) ──
async function updateEmployeeLeave(p) {
  const id = String(p.id || '').trim();
  if (!id) return { status: 'error', message: '아이디가 없습니다.' };
  const ref = db.collection('employees').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'error', message: '직원을 찾을 수 없습니다.' };
  const leaveDate = p.leaveDate || '';
  await ref.update({ leaveDate, empStatus: leaveDate ? 'resigned' : '' });
  return { status: 'ok' };
}

// ── 개인 홈 화면 설정 저장 (본인 아이디로만) ──
async function saveMyHomeTab(p) {
  const id = String(p.id || '').trim();
  if (!id) return { status: 'error', message: '아이디가 없습니다.' };
  const ref = db.collection('employees').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'error', message: '해당 아이디를 찾을 수 없습니다.' };
  await ref.update({ homeTab: p.homeTab || '' });
  return { status: 'ok' };
}

// ── 비밀번호 변경 (본인, 현재 비밀번호 확인 필요) ──
async function changePassword(p) {
  const id = String(p.id || '').trim();
  if (!id) return { status: 'error', message: '아이디가 없습니다.' };
  const currentHash = hashPassword(p.currentPassword || '');
  const newHash = hashPassword(p.newPassword || '');
  const secretSnap = await db.collection('authSecrets').doc(id).get();
  const stored = secretSnap.exists ? (secretSnap.data() || {}).pwHash : null;
  if (!stored || stored !== currentHash) return { status: 'error', message: '현재 비밀번호가 올바르지 않습니다.' };
  await db.collection('authSecrets').doc(id).set({ pwHash: newHash }, { merge: true });
  return { status: 'ok' };
}

// ── 비밀번호 초기화 (0000, 관리자 페이지) ──
async function resetPassword(p) {
  const id = String(p.id || '').trim();
  if (!id) return { status: 'error', message: '아이디가 없습니다.' };
  const empSnap = await db.collection('employees').doc(id).get();
  if (!empSnap.exists) return { status: 'error', message: '직원을 찾을 수 없습니다.' };
  const hash = hashPassword('0000');
  await db.collection('authSecrets').doc(id).set({ pwHash: hash }, { merge: true });
  return { status: 'ok' };
}

// ── 로그인 화면 "아이디 찾기" — 이름+연락처로 아이디 조회 (인증 없이도 호출 가능) ──
async function findIdByNamePhone(p) {
  const name = String(p.name || '').trim();
  const phone = String(p.phone || '').replace(/[^0-9]/g, '');
  if (!name || !phone) return { status: 'error', message: '이름과 연락처를 입력해주세요.' };
  const snap = await db.collection('employees').where('name', '==', name).get();
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    if (String(d.phone || '').replace(/[^0-9]/g, '') === phone) {
      return { status: 'ok', id: d.id || doc.id };
    }
  }
  return { status: 'error', message: '일치하는 정보를 찾을 수 없습니다.' };
}

// ── 로그인 화면 "비밀번호 찾기" — 아이디+연락처 일치 확인 후 임시 비밀번호 8자리 발급 + SMS 발송 ──
async function resetPasswordBySms(p) {
  const id = String(p.id || '').trim();
  const phone = String(p.phone || '').replace(/[^0-9]/g, '');
  if (!id || !phone) return { status: 'error', message: '아이디와 연락처를 입력해주세요.' };
  const snap = await db.collection('employees').doc(id).get();
  if (!snap.exists) return { status: 'error', message: '일치하는 정보를 찾을 수 없습니다.' };
  const emp = snap.data() || {};
  if (String(emp.phone || '').replace(/[^0-9]/g, '') !== phone) {
    return { status: 'error', message: '일치하는 정보를 찾을 수 없습니다.' };
  }

  const newPw = String(Math.floor(10000000 + Math.random() * 90000000)); // 8자리 숫자
  const newHash = hashPassword(newPw);
  await db.collection('authSecrets').doc(id).set({ pwHash: newHash }, { merge: true });

  try {
    const smsRes = await fetch(SMS_CF_URL + '?' + new URLSearchParams({
      receiver: emp.phone,
      msg: `[지복득마루] 임시 비밀번호는 ${newPw} 입니다. 로그인 후 비밀번호를 변경해주세요.`,
      // ★ (2026-09-30) 문자 서버는 이제 서버 전용 키(SERVER_API_KEY)로 호출해야 한다 — 예전 공유키는 전환 후 차단됨
      _serverKey: process.env.SERVER_API_KEY || '',
      _appKey: process.env.INTERNAL_API_KEY || ''
    }));
    const smsData = await smsRes.json();
    if (smsData.status !== 'ok') {
      return { status: 'error', message: '비밀번호는 변경됐지만 문자 발송에 실패했습니다: ' + (smsData.message || '') };
    }
  } catch (e) {
    return { status: 'error', message: '비밀번호는 변경됐지만 문자 발송에 실패했습니다: ' + e.message };
  }
  return { status: 'ok' };
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
  // 로그인 전에 쓰는 기능(로그인/아이디 찾기/비밀번호 찾기 문자)만 토큰 없이 허용
  const PUBLIC_ACTIONS = ['login', 'findIdByNamePhone', 'resetPasswordBySms'];
  if (PUBLIC_ACTIONS.indexOf(action) === -1) {
    const caller = await getCaller(params, req);
    if (!caller) return res.status(401).json(NEED_LOGIN);
    const isAdmin = caller.role === 'admin';
    const targetId = String(params.id || '').trim();
    if (action === 'changePassword' || action === 'saveMyHomeTab') {
      // 본인 것만
      if (targetId !== caller.id) return res.status(403).json(NO_PERMISSION);
    } else if (action === 'updateEmployeeInfo' && !isAdmin) {
      // 연차관리 권한자는 사용연차/조정연차만 수정 가능(연차관리 탭)
      if (!caller.leaveManagerEditor) return res.status(403).json(NO_PERMISSION);
      Object.keys(params).forEach((k) => {
        if (['id', 'usedLeave', 'annualLeave', 'action', '_appKey', '_idToken'].indexOf(k) === -1) delete params[k];
      });
    } else if (!isAdmin) {
      // addEmployee / updateEmployee / updateEmployeeLeave / resetPassword 등은 관리자만
      return res.status(403).json(NO_PERMISSION);
    }
  }
  try {
    let result;
    switch (action) {
      case 'login': result = await login(params); break;
      case 'addEmployee': result = await addEmployee(params); break;
      case 'updateEmployeeInfo': result = await updateEmployeeInfo(params); break;
      case 'updateEmployee': result = await updateEmployee(params); break;
      case 'updateEmployeeLeave': result = await updateEmployeeLeave(params); break;
      case 'saveMyHomeTab': result = await saveMyHomeTab(params); break;
      case 'changePassword': result = await changePassword(params); break;
      case 'resetPassword': result = await resetPassword(params); break;
      case 'findIdByNamePhone': result = await findIdByNamePhone(params); break;
      case 'resetPasswordBySms': result = await resetPasswordBySms(params); break;
      default: result = { status: 'error', message: '알 수 없는 action: ' + action };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
};
