// Participation certificates. Team tab (admins): preview anyone's at any time; after the end, give them to everyone in
// one tap, then download any. Today tab (participants): once given, a card to download theirs.
import { useState } from 'react';
import { api } from '../api';
import { Collapsible, day, ErrorBox, Loading, useLoad } from '../ui';
import { ReportButton } from './AdminCalendar';
import type { ChallengeView } from './Challenge';

interface List { ended: boolean; endsOn: string; people: { participantId: number; displayName: string; issuedAt: string | null }[] }
const certUrl = (pid: number) => `/api/participants/${pid}/certificate.pdf`;

export function CertificatesCard({ v }: { v: ChallengeView }) {
  const l = useLoad(() => api.get<List>(`/api/challenges/${v.challengeId}/certificates`), [v.challengeId]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const give = async () => {
    setBusy(true); setError(null);
    try { setDone((await api.post<{ issued: number }>(`/api/challenges/${v.challengeId}/certificates`)).issued); l.reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const d = l.data;
  const waiting = d?.people.filter((p) => !p.issuedAt).length ?? 0;
  return (
    <Collapsible id={`certs-${v.challengeId}`} title="🎓 Certificates" defaultOpen={false}>
      {l.loading && !d ? <Loading /> : <ErrorBox error={l.error} />}
      {d && (<>
        {!d.ended
          ? <p className="small muted" style={{ marginTop: 0 }}>Participation certificates can be given once the challenge ends (after <b>{day(d.endsOn)}</b>). Until then you can <b>preview</b> anyone's - it's marked "PREVIEW".</p>
          : waiting > 0
            ? <div className="row" style={{ marginBottom: 10 }}>
                <button className="btn primary" disabled={busy} onClick={give}>{busy ? 'Giving…' : `🎓 Give certificates to everyone (${waiting})`}</button>
                <span className="small muted">Each person gets an alert and can download theirs from the Today tab.</span>
              </div>
            : <p className="small" style={{ marginTop: 0 }}>✅ Everyone has their certificate.</p>}
        {done !== null && <div className="alert ok small">🎉 {done === 1 ? '1 certificate given' : `${done} certificates given`}.</div>}
        <ErrorBox error={error} />
        <div className="table-wrap"><table>
          <tbody>{d.people.map((p) => (
            <tr key={p.participantId}>
              <td><b>{p.displayName}</b></td>
              <td className="small muted">{p.issuedAt ? `Given ${new Date(p.issuedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : 'Not given yet'}</td>
              <td><ReportButton participantId={p.participantId} name={`${p.displayName}'s certificate`} src={certUrl(p.participantId)} label={p.issuedAt ? '🎓 Download' : '👀 Preview'} /></td>
            </tr>))}
          </tbody>
        </table></div>
      </>)}
    </Collapsible>
  );
}

/** Today tab: the participant's own certificate, once given. */
export function MyCertificate({ v }: { v: ChallengeView }) {
  const m = useLoad(() => api.get<{ participantId: number; issuedAt: string } | null>(`/api/challenges/${v.challengeId}/my-certificate`), [v.challengeId]);
  if (!m.data) return null;
  return (
    <div className="card cert-card">
      <div className="spread">
        <div><b>🎓 Your certificate of participation</b><div className="small muted">Well done for taking part in {v.name}!</div></div>
        <ReportButton participantId={m.data.participantId} name="My certificate" src={certUrl(m.data.participantId)} label="Download" primary />
      </div>
    </div>
  );
}
