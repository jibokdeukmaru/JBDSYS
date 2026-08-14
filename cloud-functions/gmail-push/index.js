// Pub/Sub-triggered Cloud Function: receives Gmail watch push notifications directly
// (replaces the old Apps Script HTTP webhook — no redirect/quota issues here).
const { google } = require('googleapis');
const { Firestore } = require('@google-cloud/firestore');

const PROJECT_ID = 'jibokdeukmaru-erp-504904';
const firestore = new Firestore({ projectId: PROJECT_ID });

const SA_EMAIL = process.env.GMAIL_SA_EMAIL;
const SA_KEY = (process.env.GMAIL_SA_KEY || '').replace(/\\n/g, '\n');
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

function gmailClientFor(email) {
  const jwt = new google.auth.JWT({
    email: SA_EMAIL,
    key: SA_KEY,
    scopes: SCOPES,
    subject: email, // 도메인 위임: 이 직원 계정으로 위임
  });
  return google.gmail({ version: 'v1', auth: jwt });
}

// Pub/Sub 트리거 함수 시그니처: (message, context)
exports.gmailPushHandler = async (message) => {
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
  } catch (e) {
    console.error('payload 디코딩 실패', e.message);
    return;
  }
  const email = decoded.emailAddress;
  const newHistoryId = decoded.historyId;
  if (!email || !newHistoryId) return;

  const stateRef = firestore.collection('gmailWatchState').doc(email);
  const stateSnap = await stateRef.get();
  const state = stateSnap.exists ? stateSnap.data() : {};
  const startHistoryId = state.historyId;

  // 재전송(Pub/Sub at-least-once) 중복 처리 방지: 이미 처리한 historyId 이하면 그냥 종료.
  if (startHistoryId && Number(newHistoryId) <= Number(startHistoryId)) {
    return;
  }

  if (startHistoryId) {
    try {
      const gmail = gmailClientFor(email);
      const hist = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: String(startHistoryId),
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
      });
      const seen = new Set();
      const batch = firestore.batch();
      let notifyCount = 0;
      for (const h of (hist.data.history || [])) {
        for (const m of (h.messagesAdded || [])) {
          const msgId = m.message.id;
          if (!msgId || seen.has(msgId)) continue;
          seen.add(msgId);
          const msg = await gmail.users.messages.get({
            userId: 'me', id: msgId, format: 'metadata',
            metadataHeaders: ['Subject', 'From'],
          });
          const headers = {};
          (msg.data.payload.headers || []).forEach((hd) => { headers[hd.name] = hd.value; });
          const ref = firestore.collection('notifications').doc();
          batch.set(ref, {
            toEmail: email,
            type: 'mail',
            title: '새 메일 도착',
            body: headers.Subject || '(제목없음)',
            relatedId: msgId,
            createdAtMs: Date.now(),
            read: false,
            sent: false,
            pushSent: false,
          });
          notifyCount++;
        }
      }
      if (notifyCount > 0) await batch.commit();
    } catch (e) {
      console.error(`Gmail history 조회 실패(${email}):`, e.message);
    }
  }

  await stateRef.set({ historyId: String(newHistoryId), updatedAtMs: Date.now() }, { merge: true });
};
