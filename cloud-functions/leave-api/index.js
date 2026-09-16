// HTTP-triggered Cloud Function: 휴가신청(부서장→대표 2단계 결재) 전체를 구글시트 대신
// Firestore(leaves 컬렉션)로 처리한다. reserve-script(Code.gs)의 applyLeave/getLeaves/
// getLeavesPublic/approveLeave/cancelLeave/requestChangeLeave/requestCancelLeave 로직을
// 그대로 이식한 것 — 서버측 결재 권한 검증(결재라인 포함 여부/직급/현재 단계 일치)도
// 원본과 동일하게 유지한다. Admin SDK를 쓰므로 firestore.rules와 무관하게 항상 접근 가능
// (leaves 컬렉션은 규칙상 클라이언트 write가 전부 막혀있고, 이 함수만 실제로 씀).
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

function nowStr() {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
function todayStr() { return nowStr().slice(0, 10); }

async function getEmployee(id) {
  const snap = await db.collection('employees').doc(String(id)).get();
  return snap.exists ? snap.data() : null;
}

async function createNotification(n) {
  try {
    await db.collection('notifications').add({
      toEmail: n.toEmail, type: n.type || '', title: n.title || '', body: n.body || '',
      relatedId: n.relatedId || '', createdAtMs: Date.now(),
      read: false, sent: false, pushSent: false
    });
  } catch (e) { console.error('createNotification 실패:', e.message); }
}

async function notifyLeaveApprover(status, approverIds, name, leaveType, days) {
  const needRole = status === '대기' ? 'manager' : status === '대표승인대기' ? 'head' : null;
  if (!needRole) return;
  for (const aid of (approverIds || [])) {
    const emp = await getEmployee(aid);
    if (!emp || !emp.email) continue;
    const isRight = needRole === 'manager' ? emp.isManager : emp.isHead;
    if (!isRight) continue;
    await createNotification({
      toEmail: emp.email, type: 'leaveApproval', title: '휴가 결재 대기',
      body: `${name}님의 ${leaveType} ${days}일 신청이 결재를 기다리고 있습니다.`
    });
  }
}

// 관리자가 과거 이력(앱 도입 전 사용분 등)을 결재 절차 없이 바로 확정 상태로 등록.
// 관리자페이지 "결재완료 내역" 카드의 수동 등록 폼에서만 호출된다.
async function adminCreateLeave(p) {
  const id = String(p.id || '');
  const days = parseFloat(p.days) || 0;
  const now = nowStr();
  const startDate = String(p.startDate || '');
  const docRef = await db.collection('leaves').add({
    empId: id, name: p.name || '', dept: p.dept || '',
    appliedAt: now, startDate, endDate: String(p.endDate || startDate),
    days, leaveType: p.leaveType || '연차', reason: p.reason || '(관리자 수동 등록)',
    status: '확정', managerApproval: '관리자 수동등록', headApproval: `관리자 수동등록(${now})`,
    approverIds: [], requestType: '', prevSnapshot: null, selectedDates: [],
    deducted: false, createdAtMs: Date.now()
  });
  return { status: 'ok', applyId: docRef.id };
}

async function submitLeave(p) {
  const id = String(p.id || '');
  const isHead = p.isHead === 'true' || p.isHead === true;
  const isManager = p.isManager === 'true' || p.isManager === true;
  const isManagerApplicant = !isHead && isManager;
  const status = isHead ? '확정' : (isManagerApplicant ? '대표승인대기' : '대기');
  const now = nowStr();
  const managerApproval = isHead ? '자동승인' : (isManagerApplicant ? '해당없음(부서장 본인 신청)' : '');
  const headApproval = isHead ? `자동승인(${now})` : '';
  const days = parseFloat(p.days) || 0;
  const approverIds = String(p.approverIds || '').split(',').map(s => s.trim()).filter(Boolean);
  let selectedDates = [];
  try { selectedDates = JSON.parse(p.selectedDates || '[]'); } catch (e) {}

  const docRef = await db.collection('leaves').add({
    empId: id, name: p.name || '', dept: p.dept || '',
    appliedAt: now, startDate: String(p.startDate || ''), endDate: String(p.endDate || ''),
    days, leaveType: p.leaveType || '연차', reason: p.reason || '',
    status, managerApproval, headApproval, approverIds, requestType: '',
    prevSnapshot: null, selectedDates, deducted: false, createdAtMs: Date.now()
  });
  if (!isHead) await notifyLeaveApprover(status, approverIds, p.name || '', p.leaveType || '연차', days);
  return { status: 'ok', applyId: docRef.id };
}

async function getLeaves(p) {
  const snap = await db.collection('leaves').get();
  let rows = snap.docs.map(d => Object.assign({ rowIdx: d.id }, d.data()));
  if (p && p.id && p.role !== 'admin') {
    const myId = String(p.id);
    rows = rows.filter(r => String(r.empId || '') === myId || (r.approverIds || []).includes(myId));
  }
  rows = rows.map(r => Object.assign({}, r, { id: r.empId }));
  return { status: 'ok', rows };
}

async function getLeavesPublic() {
  const snap = await db.collection('leaves').where('status', '==', '확정').get();
  const rows = snap.docs.map(d => d.data())
    .filter(r => r.startDate)
    .map(r => ({
      id: r.empId, name: r.name, dept: r.dept,
      startDate: r.startDate, endDate: r.endDate,
      days: r.days, leaveType: r.leaveType, status: r.status,
      selectedDates: r.selectedDates || []
    }));
  return { status: 'ok', rows };
}

async function approveLeave(p) {
  const rowIdx = String(p.rowIdx || '');
  const action = p.approveAction;
  const approverRole = p.approverRole;
  const approverId = String(p.approverId || '');
  const now = nowStr();
  const ref = db.collection('leaves').doc(rowIdx);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'error', message: '존재하지 않는 신청건입니다.' };
  const data = snap.data();
  const curStatus = String(data.status || '').trim();
  const approverIds = data.approverIds || [];

  if (!approverId || !approverIds.includes(approverId)) {
    return { status: 'error', message: '이 신청건의 결재권자가 아닙니다.' };
  }
  const emp = await getEmployee(approverId);
  if (!emp) return { status: 'error', message: '결재자 정보를 확인할 수 없습니다.' };
  if (approverRole === 'manager') {
    if (!emp.isManager) return { status: 'error', message: '부서장 결재 권한이 없습니다.' };
    if (curStatus !== '대기') return { status: 'error', message: '지금은 부서장 결재 단계가 아닙니다(이미 처리됐을 수 있음).' };
  } else if (approverRole === 'head') {
    if (!emp.isHead) return { status: 'error', message: '대표 결재 권한이 없습니다.' };
    if (curStatus !== '대표승인대기') return { status: 'error', message: '지금은 대표 결재 단계가 아닙니다(이미 처리됐을 수 있음).' };
  } else {
    return { status: 'error', message: '잘못된 결재 요청입니다.' };
  }

  const requestType = data.requestType || '';

  if (action === 'reject' && requestType) {
    const snapshot = data.prevSnapshot || null;
    if (snapshot) {
      await ref.update({
        startDate: snapshot.startDate || '', endDate: snapshot.endDate || '',
        days: snapshot.days || 0, leaveType: snapshot.leaveType || '연차',
        reason: snapshot.reason || '', status: snapshot.status || '확정',
        managerApproval: snapshot.managerApproval || '', headApproval: snapshot.headApproval || '',
        requestType: '', prevSnapshot: null
      });
      return { status: 'ok' };
    }
  }

  if (approverRole === 'manager') {
    if (action === 'approve') {
      await ref.update({ managerApproval: `승인(${now})`, status: '대표승인대기' });
      await notifyLeaveApprover('대표승인대기', approverIds, data.name || '', data.leaveType || '연차', data.days);
    } else {
      await ref.update({ managerApproval: `반려(${now})`, status: '반려' });
    }
  } else if (approverRole === 'head') {
    if (action === 'approve') {
      await ref.update({
        headApproval: `승인(${now})`,
        status: requestType === '취소' ? '취소' : '확정',
        prevSnapshot: null, requestType: ''
      });
    } else {
      await ref.update({ headApproval: `반려(${now})`, status: '반려' });
    }
  }
  return { status: 'ok' };
}

async function cancelLeave(p) {
  const rowIdx = String(p.rowIdx || '');
  const requesterId = String(p.id || '');
  const ref = db.collection('leaves').doc(rowIdx);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'error', message: '존재하지 않는 신청건입니다.' };
  const data = snap.data();
  if (String(data.empId || '').trim() !== requesterId) return { status: 'error', message: '본인만 취소 가능합니다.' };
  if (String(data.status || '').trim() !== '대기') return { status: 'error', message: '대기 상태만 취소 가능합니다.' };
  await ref.update({ status: '취소' });
  return { status: 'ok' };
}

async function requestChangeLeave(p) {
  const rowIdx = String(p.rowIdx || '');
  const requesterId = String(p.id || '');
  const ref = db.collection('leaves').doc(rowIdx);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'error', message: '존재하지 않는 신청건입니다.' };
  const data = snap.data();
  if (String(data.empId || '').trim() !== requesterId) return { status: 'error', message: '본인만 변경 가능합니다.' };
  const curStatus = String(data.status || '').trim();
  if (['반려', '취소'].includes(curStatus)) return { status: 'error', message: '변경할 수 없는 상태입니다.' };
  const curStartDate = data.startDate || '';
  if (curStartDate && curStartDate < todayStr()) return { status: 'error', message: '이미 지난 휴가는 변경할 수 없습니다.' };

  const days = parseFloat(p.days) || 0;
  let selectedDates = [];
  try { selectedDates = JSON.parse(p.selectedDates || '[]'); } catch (e) {}

  if (curStatus === '대기') {
    await ref.update({
      startDate: String(p.startDate || ''), endDate: String(p.endDate || ''),
      days, leaveType: p.leaveType || '연차', reason: p.reason || '', selectedDates
    });
  } else {
    const snapshot = {
      status: curStatus, startDate: curStartDate, endDate: data.endDate || '',
      days: data.days, leaveType: data.leaveType, reason: data.reason,
      managerApproval: data.managerApproval, headApproval: data.headApproval
    };
    await ref.update({
      startDate: String(p.startDate || ''), endDate: String(p.endDate || ''),
      days, leaveType: p.leaveType || '연차', reason: '[변경요청] ' + (p.reason || ''),
      status: '대기', managerApproval: '', headApproval: '',
      requestType: '변경', prevSnapshot: snapshot, selectedDates
    });
    await notifyLeaveApprover('대기', data.approverIds || [], data.name || '', p.leaveType || '연차', days);
  }
  return { status: 'ok' };
}

async function requestCancelLeave(p) {
  const rowIdx = String(p.rowIdx || '');
  const requesterId = String(p.id || '');
  const ref = db.collection('leaves').doc(rowIdx);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'error', message: '존재하지 않는 신청건입니다.' };
  const data = snap.data();
  if (String(data.empId || '').trim() !== requesterId) return { status: 'error', message: '본인만 취소 가능합니다.' };
  const curStatus = String(data.status || '').trim();
  const curStartDate = data.startDate || '';
  if (curStartDate && curStartDate < todayStr()) return { status: 'error', message: '이미 지난 휴가는 취소할 수 없습니다.' };

  if (curStatus === '대기') {
    await ref.update({ status: '취소' });
  } else if (curStatus === '대표승인대기' || curStatus === '확정') {
    const snapshot = {
      status: curStatus, startDate: curStartDate, endDate: data.endDate || '',
      days: data.days, leaveType: data.leaveType, reason: data.reason,
      managerApproval: data.managerApproval, headApproval: data.headApproval
    };
    await ref.update({
      reason: '[취소요청] ' + (data.reason || ''), status: '대기',
      managerApproval: '', headApproval: '', requestType: '취소', prevSnapshot: snapshot
    });
    await notifyLeaveApprover('대기', data.approverIds || [], data.name || '', data.leaveType || '연차', data.days);
  } else {
    return { status: 'error', message: '취소할 수 없는 상태입니다.' };
  }
  return { status: 'ok' };
}

exports.leaveApi = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  let bodyObj = req.body;
  if (Buffer.isBuffer(bodyObj)) bodyObj = bodyObj.toString('utf8');
  if (typeof bodyObj === 'string') {
    try { bodyObj = JSON.parse(bodyObj); } catch (e) { bodyObj = {}; }
  }
  if (!bodyObj || typeof bodyObj !== 'object' || Object.keys(bodyObj).length === 0) {
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    if (raw) { try { bodyObj = JSON.parse(raw); } catch (e) { bodyObj = {}; } }
  }
  const params = Object.assign({}, req.query, bodyObj || {});

  if (String(params._appKey || '').trim() !== String(process.env.INTERNAL_API_KEY || '').trim()) {
    return res.status(403).json({ status: 'error', message: '인증 실패' });
  }

  const action = params.action;
  try {
    let result;
    switch (action) {
      case 'applyLeave': result = await submitLeave(params); break;
      case 'adminCreateLeave': result = await adminCreateLeave(params); break;
      case 'getLeaves': result = await getLeaves(params); break;
      case 'getLeavesPublic': result = await getLeavesPublic(); break;
      case 'approveLeave': result = await approveLeave(params); break;
      case 'cancelLeave': result = await cancelLeave(params); break;
      case 'requestChangeLeave': result = await requestChangeLeave(params); break;
      case 'requestCancelLeave': result = await requestCancelLeave(params); break;
      default: result = { status: 'error', message: '알 수 없는 action: ' + action };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
};
