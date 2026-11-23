// Help: every feature, grouped, each topic collapsible; a search box filters as you type (titles, text, examples) and
// opens the matches. Topics can be linked directly: /help#correct.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Me } from '../api';
import { GROUPS, TOPICS, topicText, type Audience, type Block, type Topic } from '../help';
import { navigate } from '../router';

const AUD_LABEL: Record<Audience, string> = { everyone: 'Everyone', admin: 'Admin', finance: 'Finance', super: 'Super Admin' };

/** Text with **bold**, and the search words highlighted. */
function Rich({ text, words }: { text: string; words: string[] }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  const mark = (s: string, k: string | number): ReactNode => {
    if (!words.length) return s;
    const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return s.split(re).map((x, i) => (i % 2 ? <mark key={`${k}-${i}`}>{x}</mark> : <Fragment key={`${k}-${i}`}>{x}</Fragment>));
  };
  return <>{parts.map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <b key={i}>{mark(p.slice(2, -2), i)}</b> : <Fragment key={i}>{mark(p, i)}</Fragment>))}</>;
}

function BlockView({ b, words }: { b: Block; words: string[] }) {
  if (typeof b === 'string') return <p><Rich text={b} words={words} /></p>;
  if ('list' in b) return <ul>{b.list.map((x, i) => <li key={i}><Rich text={x} words={words} /></li>)}</ul>;
  if ('steps' in b) return <ol>{b.steps.map((x, i) => <li key={i}><Rich text={x} words={words} /></li>)}</ol>;
  if ('example' in b) return (
    <div className="help-example"><b>{b.title ?? 'Example'}</b><ul>{b.example.map((x, i) => <li key={i}><Rich text={x} words={words} /></li>)}</ul></div>);
  return <div className="help-tip">💡 <Rich text={b.tip} words={words} /></div>;
}

export function HelpPage({ me }: { me: Me }) {
  const [q, setQ] = useState('');
  const [aud, setAud] = useState<Audience | 'all'>('all');
  const [open, setOpen] = useState<Set<string>>(() => new Set(location.hash ? [location.hash.slice(1)] : []));
  const input = useRef<HTMLInputElement>(null);

  // A direct link (/help#correct) opens and scrolls to that topic.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) setTimeout(() => document.getElementById(`help-${id}`)?.scrollIntoView({ block: 'start' }), 50);
  }, []);

  const words = q.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const shown = useMemo(() => TOPICS.filter((t) =>
    (aud === 'all' || t.audience.includes(aud)) &&
    words.every((w) => topicText(t).toLowerCase().includes(w))), [q, aud]); // eslint-disable-line react-hooks/exhaustive-deps
  const searching = words.length > 0;
  const isOpen = (t: Topic) => searching || open.has(t.id);
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const audiences: (Audience | 'all')[] = ['all', 'everyone', 'admin', 'finance', 'super'];

  return (
    <>
      <button className="btn ghost small" onClick={() => history.length > 1 ? history.back() : navigate('/')}>← Back</button>
      <h1 style={{ marginTop: 8 }}>Help</h1>
      <div className="help-search">
        <input ref={input} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search help - e.g. correct, rest day, fine pool, screenshot" aria-label="Search help" autoFocus={!location.hash} />
      </div>
      <div className="row" style={{ gap: 6, margin: '10px 0' }}>
        {audiences.map((a) => (
          <button key={a} className={`btn small ${aud === a ? 'primary' : 'ghost'}`} aria-pressed={aud === a} onClick={() => setAud(a)}>{a === 'all' ? 'All topics' : AUD_LABEL[a]}</button>
        ))}
        {!searching && <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => setOpen(open.size ? new Set() : new Set(shown.map((t) => t.id)))}>{open.size ? 'Collapse all' : 'Expand all'}</button>}
      </div>
      {searching && <p className="muted small">{shown.length === 0 ? 'Nothing found - try another word, or ask an admin.' : `${shown.length} topic${shown.length === 1 ? '' : 's'} found`}</p>}
      {GROUPS.map((g) => {
        const ts = shown.filter((t) => t.group === g);
        if (!ts.length) return null;
        return (
          <section key={g} className="help-group">
            <h2>{g}</h2>
            {ts.map((t) => (
              <div key={t.id} id={`help-${t.id}`} className="card help-topic">
                <button type="button" className="collapsible-head" aria-expanded={isOpen(t)} onClick={() => toggle(t.id)}>
                  <span className="collapsible-title" style={{ fontSize: 16 }}><Rich text={t.title} words={words} /></span>
                  <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    {t.audience.map((a) => <span key={a} className={`badge ${a === 'everyone' ? 'ok' : a === 'super' ? 'warn' : 'info'}`}>{AUD_LABEL[a]}</span>)}
                    <span className="chevron" aria-hidden="true">{isOpen(t) ? '▾' : '▸'}</span>
                  </span>
                </button>
                {isOpen(t) && (
                  <div className="help-body">
                    {t.body.map((b, i) => <BlockView key={i} b={b} words={words} />)}
                    <p className="muted small" style={{ margin: '8px 0 0' }}><a href={`/help#${t.id}`} onClick={(e) => { e.preventDefault(); history.replaceState(null, '', `/help#${t.id}`); void navigator.clipboard?.writeText(`${location.origin}/help#${t.id}`).catch(() => undefined); }}>🔗 Copy link to this topic</a></p>
                  </div>
                )}
              </div>
            ))}
          </section>
        );
      })}
      <p className="muted small" style={{ marginTop: 16 }}>Still stuck? Ask one of your challenge admins. <a href="/privacy.html">Privacy policy</a></p>
    </>
  );
}
