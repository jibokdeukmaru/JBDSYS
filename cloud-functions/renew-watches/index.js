// HTTP-triggered Cloud Function (called daily by Cloud Scheduler): renews Gmail watch()
// registrations for every active employee — Gmail watch expires after max 7 days.
const { google } = require('googleapis');
const { Firestore } = require('@google-cloud/firestore');
const fetch = require('node-fetch');

const PROJECT_ID = 'jibokdeukmaru-erp-504904';
const TOPIC = `projects/${PROJECT_ID}/topics/gmail-push`;
const firestore = new Firestore({ projectId: PROJECT_ID });

const SA_EMAIL = process.env.GMAIL_SA_EMAIL;
const SA_KEY = (process.env.GMAIL_SA_KEY || '').replace(/\\n/g, '\n');
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const RESERVE_URL = process.env.RESERVE_URL; // 예: RESERVE스크립트 배포 /exec URL

exports.renewWatches = async (req, res) => {
  if ((req.query && req.query._appKey) !== INTERNAL_KEY) {
    return res.status(403).send('인증 실패');
  }
  try {
    const empRes = await fetch(`${RESERVE_URL}?action=getEmployees&_appKey=${encodeURIComponent(INTERNAL_KEY)}`);
    const empData = await empRes.json();
    const employees = (empData.rows || []).filter((e) => !e.leaveDate && e.email);

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
