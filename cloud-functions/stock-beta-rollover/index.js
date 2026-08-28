// HTTP-triggered Cloud Function (called daily by Cloud Scheduler, same pattern as
// renew-watches): 재고현황(BETA)의 실시간재고 월별 데이터가 항상 "이번 달의 다음 달"까지
// 미리 준비돼 있도록 한다. 예약현황(resv)은 이 롤오버와 무관하게 그대로 복사만 해서
// 넘긴다 - 이 함수가 직접 예약을 만들거나 지우지 않는다.
const { Firestore } = require('@google-cloud/firestore');

const PROJECT_ID = 'jibokdeukmaru-erp-504904';
const firestore = new Firestore({ projectId: PROJECT_ID });
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;

function currentRealMonth(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
// month는 "YYYY-MM"(예: "2026-08") — 그 달의 1일 기준으로 다음 달을 계산한다.
function nextMonthOf(month) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(y, m, 1); // Date 생성자는 month가 0-based라, 1-based인 m을 그대로 넣으면 다음달 1일이 된다.
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function cleanIdPart(s) {
  return String(s || '').replace(/[\/\r\n\t]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
}

exports.stockBetaMonthlyRollover = async (req, res) => {
  if ((req.query && req.query._appKey) !== INTERNAL_KEY) {
    return res.status(403).send('인증 실패');
  }
  try {
    const statusSnap = await firestore.collection('stockBetaMeta').doc('status').get();
    if (!statusSnap.exists || !statusSnap.data().migrated) {
      return res.json({ status: 'ok', skipped: '아직 완전이관 전 - 롤오버 대상 없음' });
    }

    const monthsSnap = await firestore.collection('stockBetaMeta').doc('months').get();
    const months = (monthsSnap.exists && monthsSnap.data().list) || [];
    if (!months.length) return res.json({ status: 'ok', skipped: '월 데이터 없음' });

    // 항상 "이번 달의 다음 달"이 존재하는지 확인 — 이미 있으면 할 일 없음(하루에 여러 번
    // 호출돼도 안전, 매일 실행해도 무방).
    const target = nextMonthOf(currentRealMonth());
    if (months.includes(target)) {
      return res.json({ status: 'ok', skipped: '이미 존재함', target });
    }

    // 롤오버 기준(소스)은 지금 있는 달 중 가장 최신 달의 "반영후"(box - ship 합계) 수치.
    const sourceMonth = months.slice().sort().pop();
    const sourceSnap = await firestore.collection('stockBetaLots').where('month', '==', sourceMonth).get();
    if (sourceSnap.empty) return res.json({ status: 'ok', skipped: '소스 달에 LOT 없음', sourceMonth });

    const batch = firestore.batch();
    let count = 0;
    sourceSnap.forEach((doc) => {
      const lot = doc.data();
      const shipSum = (lot.ship || []).reduce((s, x) => s + (typeof x.box === 'number' ? x.box : 0), 0);
      const finalBox = Math.round((Number(lot.box || 0) - shipSum) * 10) / 10;
      const ratio = (parseFloat(lot.heibei) || 0) / 3.24;
      const finalPy = Math.round(finalBox * ratio * 10) / 10;
      const newId = cleanIdPart(lot.sheetName) + '__' + cleanIdPart(lot.code) + '__' + cleanIdPart(lot.cha || '-') + '__' + cleanIdPart(target);
      const ref = firestore.collection('stockBetaLots').doc(newId);
      batch.set(ref, {
        sheetName: lot.sheetName, code: lot.code, cha: lot.cha, month: target,
        inDate: lot.inDate || '', spec: lot.spec || '', heibei: lot.heibei || '',
        box: finalBox, py: finalPy,
        ship: [],           // 출고현황은 새 달에서 완전히 빈 상태로 시작
        resv: lot.resv || [], // 예약현황은 월과 무관하게 이어지는 개념이라 최신값 그대로 복사
        _merged: !!lot._merged,
        updatedAtMs: Date.now(),
      });
      count++;
    });
    await batch.commit();

    months.push(target);
    months.sort();
    await firestore.collection('stockBetaMeta').doc('months').set({ list: months }, { merge: true });

    res.json({ status: 'ok', created: target, sourceMonth, count });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
};
