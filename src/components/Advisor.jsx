// Company ▸ Advisor — the game's own rule-based tips, and the airline briefing.
//
// PRD (Discord, 2026-11-07) asked for "an AI manager that looks at your
// airline's current situation and gives you tips". Two halves, both free:
//
//   1. ADVICE. engine models/advisor.js reads the same projection the
//      Dashboard's alert strip reads (projectWeekShared) and turns it into
//      levers: which tails to put to work, which routes to reprice or trim,
//      which checks to book, which gates are full. Each one deep-links to the
//      screen that pulls the lever. The alerts are shown above it so this page
//      is the one place to start a session.
//   2. BRIEFING. "Copy airline briefing" puts engine models/briefing.js on the
//      clipboard — the airline as Markdown, advice included — for the player to
//      paste into whatever AI they already use. Nothing is sent anywhere.
//
// The supporters' read-only API that serves the same briefing to a connected
// Claude/ChatGPT is set up from the LOBBY (apps/headwinds-web AiConnectorCard),
// never mentioned here: the support ask stays out of the gameplay loop
// (apps/headwinds-web/src/SupportCard.jsx).

import { useMemo, useState } from 'react';
import { useGame } from '../store/GameContext.jsx';
import { airlineAdvice } from '../../packages/engine/src/models/advisor.js';
import { airlineBriefing } from '../../packages/engine/src/models/briefing.js';
import { projectWeekShared, airlineAlerts } from '../utils/airlineAlerts.js';
import { requestNav } from '../utils/navIntent.js';
import { navPathFor } from '../navPath.js';
import { screenGuide, actionPathText } from '../screenGuide.js';
import { formatMoney } from '../utils/simulation.js';
import { BulbIcon, ClipboardIcon, CheckIcon } from './Icons.jsx';

const PRIORITY_COLOR = { 1: 'var(--red)', 2: 'var(--yellow)', 3: 'var(--accent)' };

/** The advice + alerts + briefing for a state, off the shared projection. */
export function useAdvisor(state) {
  return useMemo(() => {
    if (!state || state.phase !== 'playing') return { advice: [], alerts: [], proj: null };
    let proj = null;
    try { proj = projectWeekShared(state); } catch { proj = null; }
    const report = proj?.report ?? state.lastReport ?? null;
    let alerts = [];
    try { alerts = proj ? airlineAlerts(state, proj) : []; } catch { alerts = []; }
    return { advice: airlineAdvice(state, report), alerts, proj, report };
  }, [state]);
}

function AdviceCard({ a, remote }) {
  const color = PRIORITY_COLOR[a.priority] ?? 'var(--text-dim)';
  const target = a.action ? navPathFor(a.action.to, { remote }) : null;
  return (
    <div className="card" data-advice={a.id} style={{ borderLeft: `3px solid ${color}`, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase',
          color, border: `1px solid ${color}`, borderRadius: 4, padding: '2px 6px', flexShrink: 0,
        }}>{a.priorityLabel}</span>
        <strong style={{ fontSize: 14, color: 'var(--text)', flex: 1, minWidth: 180 }}>{a.title}</strong>
        {a.impact != null && a.impact !== 0 && (
          <span style={{ fontSize: 12, color: a.impact < 0 ? 'var(--red)' : 'var(--green)' }}
                title="Estimate, per week">
            {a.impact > 0 ? '+' : ''}{formatMoney(a.impact)}/wk
          </span>
        )}
      </div>
      <p style={{ margin: '8px 0', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 }}>{a.detail}</p>
      {a.items?.length > 0 && (
        <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 12, color: 'var(--text-dim)' }}>
          {a.items.map((it, i) => (
            <li key={i}><span style={{ color: 'var(--text)' }}>{it.label}</span> — {it.value}</li>
          ))}
        </ul>
      )}
      {target && (
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '5px 12px' }}
          onClick={() => requestNav(a.action.to, {
            ...(a.action.filter ? { filter: a.action.filter } : {}),
            ...(a.action.focus ? { focus: a.action.focus } : {}),
          })}
          title={`Go to ${target}`}
        >
          {a.action.label} →
        </button>
      )}
    </div>
  );
}

// What the two briefing buttons do and how to use them. Always-visible steps,
// the detail folded away: most players need the three lines, a few want to
// know exactly what leaves the page.
const EXAMPLE_QUESTIONS = [
  'What should I fix first this week?',
  'Which routes should I reprice, and which way?',
  'Where am I wasting aircraft or gates?',
  'Why did my profit drop?',
];

function BriefingHelp() {
  const step = (n, text) => (
    <li style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
      <span style={{
        flexShrink: 0, width: 18, height: 18, borderRadius: 9, fontSize: 11, fontWeight: 700,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--surface2)', color: 'var(--accent)',
      }}>{n}</span>
      <span>{text}</span>
    </li>
  );
  return (
    <div data-advisor="briefing-help" style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
      <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>Ask your own AI about your airline</div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {step(1, <><strong>Copy airline briefing</strong> puts your airline on the clipboard as text (or <strong>Download .md</strong> saves it as a file).</>)}
        {step(2, <>Open Claude, ChatGPT or any AI chat you use, and paste it in — or attach the file.</>)}
        {step(3, <>Ask it anything: {EXAMPLE_QUESTIONS.map((q, i) => (
          <span key={q}>{i > 0 ? ', ' : ''}<em>“{q}”</em></span>
        ))}.</>)}
      </ol>
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--text-dim)' }}>What's in the briefing, and what isn't</summary>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--text-dim)' }}>
          <li><strong>In it:</strong> cash and recent profit, these Advisor tips, your best and worst routes (load, revenue, profit, fares against the reference fare, how many rivals), your fleet by type, gate use and your main settings — and a guide to where every page is in the game, so your AI can tell you exactly where to click (in the classic layout or the map view).</li>
          <li><strong>Not in it:</strong> anything about other players beyond the number of rivals on each of your routes. Only your own airline.</li>
          <li><strong>Private:</strong> the game sends nothing anywhere. The text only goes where you paste it.</li>
          <li><strong>A snapshot:</strong> route figures are this week's projection. After you change things, copy it again so your AI isn't working from old numbers.</li>
          <li><strong>Advice, not autopilot:</strong> an AI reading the briefing can't change anything in the game — you act on what it suggests. It has no market data for routes you don't fly yet, so for new routes use Network ▸ Route Finder.</li>
        </ul>
      </details>
    </div>
  );
}

export default function Advisor() {
  const { state, remote } = useGame();
  const { advice, alerts, report } = useAdvisor(state);
  const [copied, setCopied] = useState(null);      // null | 'ok' | 'manual'
  const [manualText, setManualText] = useState('');

  const briefing = () => airlineBriefing(state, {
    report,
    reportLabel: "this week's projection",
    advice,
    pathFor: (id) => navPathFor(id, { remote }),
    actionPath: (action) => actionPathText(action, { remote }),
    screens: screenGuide(state, { remote }),
  });

  const copy = async () => {
    const text = briefing();
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
      setTimeout(() => setCopied(null), 2500);
    } catch {
      // Clipboard blocked (insecure context, browser policy): show the text
      // selected so the player can copy it by hand.
      setManualText(text);
      setCopied('manual');
    }
  };

  const download = () => {
    const blob = new Blob([briefing()], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(state.airlineName || 'airline').replace(/[^\w-]+/g, '-').toLowerCase()}-briefing.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--accent)', display: 'inline-flex' }}><BulbIcon size={18} /></span>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="card-title" style={{ marginBottom: 2 }}>Advisor</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              Tips worked out from your own airline's figures — this week's projection, the same one the
              Dashboard reads. Rule-based and private: nothing leaves the game.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" data-advisor="copy-briefing" onClick={copy}
                    title="Copies your airline to the clipboard as text, ready to paste into Claude, ChatGPT or any AI chat">
              {copied === 'ok' ? <><CheckIcon size={14} /> Copied</> : <><ClipboardIcon size={14} /> Copy airline briefing</>}
            </button>
            <button type="button" className="btn btn-ghost" onClick={download} title="Saves the same text as a .md file — handy for a big airline, or to attach to a chat instead of pasting">
              Download .md
            </button>
          </div>
        </div>
        <BriefingHelp />
        {copied === 'manual' && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--yellow)', marginBottom: 6 }}>
              Your browser blocked automatic copying — select all below and copy it.
            </div>
            <textarea readOnly value={manualText} onFocus={(e) => e.target.select()} autoFocus
                      style={{ width: '100%', height: 180, fontFamily: 'monospace', fontSize: 11 }} />
          </div>
        )}
      </div>

      {alerts.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-title">Alerts</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {alerts.map((al) => {
              const target = al.to ? navPathFor(al.to, { remote }) : null;
              return (
                <button key={al.id} type="button" disabled={!target}
                  onClick={target ? () => requestNav(al.to, { filter: al.filter }) : undefined}
                  style={{
                    display: 'flex', gap: 10, alignItems: 'center', padding: '7px 12px',
                    background: 'var(--surface2)', border: 'none', borderLeft: `3px solid ${al.color}`,
                    borderRadius: 'var(--radius)', font: 'inherit', fontSize: 13, textAlign: 'left',
                    width: '100%', cursor: target ? 'pointer' : 'default', color: 'var(--text)',
                  }}>
                  <span style={{ flex: 1 }}>{al.text}</span>
                  {target && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{target} →</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {advice.length === 0 ? (
        <div className="card" data-advice="none">
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Nothing to flag this week. Check back after you grow — the Advisor looks at every route, tail and gate each time you open it.
          </div>
        </div>
      ) : (
        advice.map((a) => <AdviceCard key={a.id} a={a} remote={remote} />)
      )}
    </div>
  );
}
