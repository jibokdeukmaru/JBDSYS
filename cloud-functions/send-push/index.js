// Firestore 문서 생성 트리거: notifications 컬렉션에 새 문서가 생기는 "순간" 실행된다
// (1분마다 확인하러 가는 폴링이 아니라, gmail-push와 동일한 이벤트 기반 방식 — 지연 없음).
// 안드로이드 FCM 푸시를 발송하고, pushSent를 true로 표시한다(Admin SDK의 update()는
// 부분 업데이트라 다른 필드를 건드리지 않는다 — 예전 Apps Script REST PATCH가 updateMask
// 없이 문서를 통째로 덮어쓰던 문제가 여기서는 애초에 발생하지 않는다).
const { google } = require('googleapis');
const { Firestore } = require('@google-cloud/firestore');
const fetch = require('node-fetch');

const PROJECT_ID = 'jibokdeukmaru-erp-504904';
const firestore = new Firestore({ projectId: PROJECT_ID });

exports.sendPush = async (cloudEvent) => {
  // ★ subject는 CloudEvent 봉투 자체의 평문 문자열 필드라 항상 안전하게 읽을 수 있다
  //   (data 안의 프로토버프 디코딩이 혹시 실패해도 subject는 영향받지 않음).
  const dataName = cloudEvent.data && cloudEvent.data.value && cloudEvent.data.value.name;
  const subjectPath = cloudEvent.subject; // "documents/notifications/{docId}"
  const docId = (dataName && dataName.split('/').pop())
    || (subjectPath && subjectPath.split('/').pop())
    || null;
  console.log('[sendPush] 트리거 수신 — subject=' + subjectPath + ' dataName=' + dataName + ' → docId=' + docId);
  if (!docId) { console.error('[sendPush] docId를 못 찾음 — 종료'); return; }

  const ref = firestore.collection('notifications').doc(docId);
  const snap = await ref.get();
  if (!snap.exists) { console.error('[sendPush] 문서 없음(docId=' + docId + ') — 종료'); return; }
  const n = snap.data();
  if (n.pushSent === true) { console.log('[sendPush] 이미 발송됨(docId=' + docId + ') — 종료'); return; }
  console.log('[sendPush] toEmail=' + n.toEmail + ' title=' + n.title);

  try {
    const tokenSnap = await firestore.collection('pushTokens').doc(n.toEmail || '').get();
    const token = tokenSnap.exists ? (tokenSnap.data() || {}).token : null;
    console.log('[sendPush] pushTokens 조회 결과 — exists=' + tokenSnap.exists + ' token=' + (token ? token.slice(0, 12) + '...' : '(없음)'));

    if (token) {
      const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
      const client = await auth.getClient();
      const { token: accessToken } = await client.getAccessToken();

      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: {
              title: n.title || '지복득마루 ERP',
              body: n.body || '',
              image: 'https://sys.jibokdeukmaru.com/notify-icon.png'
            },
            android: {
              notification: { icon: 'ic_launcher', color: '#A2693E' }
            }
          }
        })
      });
      const data = await res.json();
      if (data.error) console.error('[sendPush] FCM 발송 실패:', JSON.stringify(data.error));
      else console.log('[sendPush] FCM 발송 성공:', JSON.stringify(data));
    } else {
      console.error('[sendPush] pushTokens/' + n.toEmail + ' 문서에 토큰이 없어 발송 못함');
    }
  } catch (e) {
    console.error('[sendPush] 예외 발생(docId=' + docId + '):', e.message, e.stack);
  }

  await ref.update({ pushSent: true });
};
