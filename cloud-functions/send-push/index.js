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
  const name = cloudEvent.data && cloudEvent.data.value && cloudEvent.data.value.name;
  const docId = name ? name.split('/').pop() : null;
  if (!docId) return;

  const ref = firestore.collection('notifications').doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const n = snap.data();
  if (n.pushSent === true) return; // 재전달(at-least-once) 시 중복 발송 방지

  try {
    const tokenSnap = await firestore.collection('pushTokens').doc(n.toEmail || '').get();
    const token = tokenSnap.exists ? (tokenSnap.data() || {}).token : null;

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
      if (data.error) console.error('FCM 발송 실패:', JSON.stringify(data.error));
    }
  } catch (e) {
    console.error('푸시 발송 실패(docId=' + docId + '):', e.message);
  }

  await ref.update({ pushSent: true });
};
