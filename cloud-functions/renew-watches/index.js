// HTTP-triggered Cloud Function (called daily by Cloud Scheduler): renews Gmail watch()
// registrations for every active employee — Gmail watch expires after max 7 days.
const { google } = require('googleapis');
const { Firestore } = require('@google-cloud/firestore');

const PROJECT_ID = 'jibokdeukmaru-erp-504904';
const TOPIC = `projects/${PROJECT_ID}/topics/gmail-push`;
const firestore = new Firestore({ projectId: PROJECT_ID });

const SA_EMAIL = process.env.GMAIL_SA_EMAIL;
const SA_KEY = (process.env.GMAIL_SA_KEY || '').replace(/\\n/g, '\n');
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;

exports.renewWatches = async (req, res) => {
  if ((req.query && req.query._appKey) !== INTERNAL_KEY) {
    return res.status(403).send('인증 실패');
  }
  try {
    // ★ (2026-10-02) 직원 목록을 구글시트(RESERVE스크립트) 대신 Firestore employees에서 직접 읽는다 —
    //   공용 메일함 지정(mailbox)은 Firestore에만 있다. 지정된 직원은 개인 메일함 대신 그 공용 메일함을
    //   감시 대상으로 넣고(여러 명이 같은 메일함이면 한 번만), 지정 없으면 기존처럼 본인 사내 이메일.
    const today = new Date().toISOString().slice(0, 10);
    const empSnap = await firestore.collection('employees').get();
    const boxes = new Set();
    empSnap.forEach((d) => {
      const e = d.data() || {};
      if (e.leaveDate && String(e.leaveDate) <= today) return;
      const box = String(e.mailbox || e.email || '').trim().toLowerCase();
      if (box) boxes.add(box);
    });
    const employees = Array.from(boxes).map((email) => ({ email }));

    let ok = 0;
    for (const emp of employees) {
      try {
        const jwt = new google.auth.JWT({
          email: SA_EMAIL,
          key: SA_KEY,
          scopes: ['https://www.googleapis.com/auth/gmail.modify'],
          subject: emp.email,
        });
        const gmail = google.gmail({ version: 'v1', auth: jwt });
        const result = await gmail.users.watch({
          userId: 'me',
          requestBody: { topicName: TOPIC, labelIds: ['INBOX'] },
        });
        await firestore.collection('gmailWatchState').doc(emp.email).set({
          historyId: String(result.data.historyId),
          expiration: String(result.data.expiration),
          updatedAtMs: Date.now(),
        }, { merge: true });
        ok++;
      } catch (e) {
        console.error(`watch 갱신 실패(${emp.email}):`, e.message);
      }
    }
    res.json({ status: 'ok', renewed: ok, total: employees.length });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
};
