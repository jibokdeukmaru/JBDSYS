// Firestore 문서 생성 트리거: notifications 컬렉션에 새 문서가 생기는 "순간" 실행된다
// (1분마다 확인하러 가는 폴링이 아니라, gmail-push와 동일한 이벤트 기반 방식 — 지연 없음).
//
// ★ CloudEvent 안에 담긴 프로토버프 페이로드(어떤 문서가 생겼는지)는 일부러 파싱하지 않는다 —
//   환경별로 디코딩이 까다롭고 실제로 subject/data 둘 다 비어서 오는 경우가 확인됨.
//   대신 이벤트는 "뭔가 새로 생겼다"는 신호로만 쓰고, 매번 pushSent=false인 알림을 전부
//   조회해서 처리한다 — 멱등적이라(이미 보낸 건 pushSent=true라 다시 안 걸림) 훨씬 안전하다.
const { google } = require('googleapis');
const { Firestore } = require('@google-cloud/firestore');
const fetch = require('node-fetch');

const PROJECT_ID = 'jibokdeukmaru-erp-504904';
const firestore = new Firestore({ projectId: PROJECT_ID });

exports.sendPush = async () => {
  const pending = await firestore.collection('notifications').where('pushSent', '==', false).limit(20).get();
  console.log('[sendPush] 대기중 알림 ' + pending.size + '건');
  if (pending.empty) return;

  let accessToken = null;
  async function getAccessToken() {
    if (accessToken) return accessToken;
    const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
    const client = await auth.getClient();
    const res = await client.getAccessToken();
    accessToken = res.token;
    return accessToken;
  }

  for (const doc of pending.docs) {
    const n = doc.data();
    // ★ 알림이 짧은 간격으로 여러 개 생기면 이 함수가 겹쳐 실행될 수 있는데, 그때 둘 다 같은
    //   pushSent==false 문서를 집어서 중복 발송하는 문제가 있었다(gmail-push와 같은 유형의
    //   버그) — 실제 발송 전에 트랜잭션으로 먼저 이 문서를 "내가 처리한다"고 선점(pushSent:true)
    //   해두고, 선점에 실패(이미 처리됨)하면 조용히 건너뛴다.
    let claimed = false;
    try {
      await firestore.runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists || fresh.data().pushSent) return;
        tx.update(doc.ref, { pushSent: true });
        claimed = true;
      });
    } catch (e) {
      console.error('[sendPush] 선점 실패(docId=' + doc.id + '):', e.message);
    }
    if (!claimed) {
      console.log('[sendPush] 이미 다른 실행이 처리 중이라 건너뜀(docId=' + doc.id + ')');
      continue;
    }
    try {
      const tokenSnap = await firestore.collection('pushTokens').doc(n.toEmail || '').get();
      const tokenData = tokenSnap.exists ? (tokenSnap.data() || {}) : null;
      const token = tokenData ? tokenData.token : null;
      const firstRegisteredAtMs = tokenData ? tokenData.firstRegisteredAtMs : null;
      console.log('[sendPush] docId=' + doc.id + ' toEmail=' + n.toEmail + ' token=' + (token ? '있음' : '없음'));

      // ★ 이 알림이 이 사용자의 앱 설치(푸시 토큰 최초 등록)보다 이전에 만들어진 거면
      //   설치 전에 쌓인 옛날 메일이므로 발송하지 않고 조용히 넘어간다.
      if (token && firstRegisteredAtMs && n.createdAtMs && n.createdAtMs < firstRegisteredAtMs) {
        console.log('[sendPush] 설치 이전 알림이라 발송 생략(docId=' + doc.id + ')');
      } else if (token) {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              notification: {
                title: n.title || '지복득마루 ERP',
                body: n.body || ''
              },
              android: {
                notification: { icon: 'ic_launcher', color: '#A2693E' }
              }
            }
          })
        });
        const data = await res.json();
        if (data.error) console.error('[sendPush] FCM 발송 실패(docId=' + doc.id + '):', JSON.stringify(data.error));
        else console.log('[sendPush] FCM 발송 성공(docId=' + doc.id + ')');
      } else {
        console.error('[sendPush] pushTokens/' + n.toEmail + ' 문서에 토큰이 없어 발송 못함(docId=' + doc.id + ')');
      }
    } catch (e) {
      console.error('[sendPush] 예외(docId=' + doc.id + '):', e.message);
    }
    // pushSent는 위 트랜잭션 선점 단계에서 이미 true로 표시했으므로 여기서 다시 표시할 필요 없음.
  }
};
