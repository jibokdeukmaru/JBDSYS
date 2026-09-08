// Pub/Sub-triggered Cloud Function: receives Gmail watch push notifications directly
// (replaces the old Apps Script HTTP webhook — no redirect/quota issues here).
const { google } = require('googleapis');
const { Firestore } = require('@google-cloud/firestore');

const PROJECT_ID = 'jibokdeukmaru-erp-504904';
const firestore = new Firestore({ projectId: PROJECT_ID });

const SA_EMAIL = process.env.GMAIL_SA_EMAIL;
const SA_KEY = (process.env.GMAIL_SA_KEY || '').replace(/\\n/g, '\n');
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

// 한 사람이 sales/rnd 같은 그룹 여러 개에 동시에 속해 있으면, 메일 1통이 그룹 확장으로
// 그 사람의 같은 받은편지함에 서로 다른 메시지ID를 가진 메일 2통으로 이중 배달되는 경우가
// 있다(예: admin이 sales+rnd 그룹 모두 멤버). 이땐 메시지ID가 실제로 다르므로 아래
// email+msgId 기반 dedup을 통과해버려 알림이 2개 뜬다 — 알림 문서 자체는 두 통 다 남기되
// (메일함 히스토리 상 실제로 2통 온 게 맞으므로), 짧은 시간 안에 같은 수신자에게 같은 제목의
// 알림이 이미 있으면 푸시(진동/알림음)만 한 번으로 억제한다.
const DUPLICATE_PUSH_WINDOW_MS = 2 * 60 * 1000;

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
      let notifyCount = 0;
      for (const h of (hist.data.history || [])) {
        for (const m of (h.messagesAdded || [])) {
          const msgId = m.message.id;
          if (!msgId || seen.has(msgId)) continue;
          seen.add(msgId);
          // 메일 하나에 Gmail이 거의 동시에 푸시를 여러 번 보내는 경우가 있는데, 그럴 때마다
          // 이 함수가 겹쳐 실행되면서(둘 다 갱신 전 historyId를 기준으로 읽음) 같은 메일에
          // 대해 알림 문서를 중복 생성하는 문제가 있었다 — 문서 ID를 메시지마다 고정값으로
          // 만들고 create()(이미 있으면 실패)를 써서, 몇 개가 동시에 처리하든 같은 메일엔
          // 알림이 정확히 1개만 만들어지도록 한다.
          const ref = firestore.collection('notifications').doc(email + '_' + msgId);
          let msg;
          try {
            msg = await gmail.users.messages.get({
              userId: 'me', id: msgId, format: 'metadata',
              metadataHeaders: ['Subject', 'From'],
            });
          } catch (e) {
            console.error(`메일 조회 실패(${email}, ${msgId}):`, e.message);
            continue;
          }
          const headers = {};
          (msg.data.payload.headers || []).forEach((hd) => { headers[hd.name] = hd.value; });
          const subject = headers.Subject || '(제목없음)';

          // 같은 수신자 + 같은 제목으로 최근에 만들어진 알림이 있으면(그룹 이중배달 등으로
          // 인한 유사중복) 이번 알림은 문서만 만들고 푸시는 생략한다. toEmail/body 둘 다
          // 등호(==) 비교라 Firestore 복합 인덱스 없이도 쿼리 가능.
          let suppressPush = false;
          try {
            const recentSnap = await firestore.collection('notifications')
              .where('toEmail', '==', email)
              .where('body', '==', subject)
              .limit(5)
              .get();
            const cutoff = Date.now() - DUPLICATE_PUSH_WINDOW_MS;
            suppressPush = recentSnap.docs.some((d) => (d.data().createdAtMs || 0) > cutoff);
          } catch (e) {
            console.error(`중복 체크 실패(${email}, ${msgId}):`, e.message);
          }

          try {
            await ref.create({
              toEmail: email,
              type: 'mail',
              title: '새 메일 도착',
              body: subject,
              relatedId: msgId,
              createdAtMs: Date.now(),
              read: false,
              sent: false,
              pushSent: suppressPush,
            });
            notifyCount++;
          } catch (e) {
            if (e.code === 6) {
              // ALREADY_EXISTS — 동시에 처리된 다른 실행이 이미 이 메일 알림을 만들어놓음, 정상 상황
              continue;
            }
            throw e;
          }
        }
      }
    } catch (e) {
      console.error(`Gmail history 조회 실패(${email}):`, e.message);
    }
  }

  await stateRef.set({ historyId: String(newHistoryId), updatedAtMs: Date.now() }, { merge: true });
};
