import { useState } from 'react';
import { Glyph } from './Icons.jsx';
import { useGame } from '../store/GameContext.jsx';

// Bump this version whenever the tour content changes so returning players
// see the updated guidance once (v2 added: Market filtering, idle-aircraft
// assignment, and a "More to Explore" sweep of commonly-missed features).
export const TOUR_KEY = 'bbae_tour_seen_v2';

const STEPS = [
  {
    icon: '✈️',
    title: 'Welcome to Tailwinds - Airline Manager',
    remoteTitle: 'Welcome to Headwinds - Multiplayer Airline Manager',
    body: "You've founded your airline with $15 million in equity capital — yours to invest, with no debt to service. Your mission: build a profitable route network before you burn through it. Spend wisely; the bank is there if you need a loan later.",
    remoteBody: "You've founded your airline with $15 million in equity capital — the same opening every player in this world gets. Your mission: build a profitable route network before you burn through it, in a shared world where every competitor is a real person.",
    highlight: null,
  },
  {
    icon: '🎯',
    title: 'What You\'re Trying to Do',
    body: "Every week you collect ticket revenue. Every week costs come out — fuel, crew, leases, loan repayments. Stay profitable, grow your network, and outlast the competition.",
    remoteBody: "Every week you collect ticket revenue. Every week costs come out — fuel, crew, leases, loan repayments. Stay profitable, grow your network, and climb the standings — the leaderboard ranks every human airline in this world by market cap.",
    highlight: null,
  },
  {
    icon: '🛒',
    title: 'Step 1 — Get an Aircraft',
    body: 'Open the Market tab. Lease a Turboprop or Regional Jet to start — they\'re cheap to run with low commitment. You can order larger aircraft later once you have capital.',
    highlight: 'Market',
  },
  {
    icon: '🔎',
    title: 'Tip — Filter the Market',
    body: "The Market is filterable. Use the category tabs at the top (Turboprop, Regional Jet, Narrowbody, Widebody) to narrow the list, then the manufacturer pills below to filter by maker. Both controls update the aircraft grid live — a quick way to find exactly the plane you want.",
    highlight: 'Market',
  },
  {
    icon: '🗺️',
    title: 'Step 2 — Open a Route',
    body: "Go to Routes → Open Route (or use the Route Planner tab). Pick two airports, choose your aircraft, and set a ticket price. You already have a gate at your hub — you'll need to buy one at your destination first.",
    highlight: 'Routes',
  },
  {
    icon: '🛫',
    title: 'Tip — Put Idle Aircraft to Work',
    body: "An aircraft earns nothing until it's flying a route. Any plane not yet assigned shows as \"idle\" in your Fleet. To assign one: open the Route Planner (or Routes → Open Route), pick your airports, and choose an aircraft type — the picker shows how many idle planes you have of each type. Hit \"Open Route\" and the idle aircraft is deployed. Aircraft with spare hours can even take on a second route.",
    highlight: 'Route Planner',
  },
  {
    icon: '⏩',
    title: 'Step 3 — Advance the Week',
    remoteTitle: 'Step 3 — The World Clock',
    body: "Hit Next Week in the top bar to fly your routes and collect revenue. The game also auto-advances every hour. Check your Dashboard after each week — it shows alerts when something needs attention.",
    remoteBody: "Time belongs to the world, not to you: the server advances every airline one week at a time, in lockstep, on this world's pace (shown in the lobby). Your routes fly and your bills come due even while you're away — check the Dashboard when you come back.",
    highlight: 'Next Week',
    remoteHighlight: '',
  },
  {
    icon: '⚔️',
    title: 'Your Rivals Are Real',
    body: '',
    remoteBody: "Every other airline in this world is a real person making real decisions. Open the Rivals tab to see the leaderboard and go head-to-head on contested routes — when a rival flies one of your city pairs, you split its passengers based on price, quality and frequency. There are no AI airlines in Headwinds.",
    highlight: null,
    remoteHighlight: 'Rivals',
    remoteOnly: true,
  },
  {
    icon: '💀',
    title: 'How You Go Bankrupt',
    body: "Two ways to lose:\n• Miss 3 loan payments (cash goes negative on a week when loans are due)\n• Stay cash-negative for 6 consecutive weeks\n\nWatch Finance. Manage your debt early. Warning toasts will appear before either limit is reached.",
    highlight: 'Finance',
  },
  {
    icon: '🧭',
    title: 'More to Explore',
    body: "A few features players often miss:\n• Hubs — build up a base airport to feed connecting traffic\n• Operations — manage crews, maintenance and reliability\n• Loyalty & Reputation — grow repeat demand and brand\n• Map & Route Planner — visualise your network and preview a route's profit before you commit\n\nHover the ⓘ icons next to controls anywhere in the game for a quick explanation, and check the Help tab for the full wiki.",
    highlight: 'Help',
  },
  {
    icon: '🏆',
    title: "You're Ready to Fly",
    body: "That's everything you need to know. Good luck — the skies are competitive.\n\nOne more thing: every playthrough is different. Fuel prices fluctuate, random events fire at different times and intensities, aircraft failures are unpredictable, and regional booms or downturns can hit different parts of the world each run — so the same strategy won't always produce the same result.\n\nYou can reopen this guide anytime with the ? button in the top bar.",
    highlight: null,
    last: true,
  },
];

export default function OnboardingTour({ onClose }) {
  // Multiplayer (Headwinds) shows the same tour with reworded steps: the brand,
  // the server-owned world clock, and human rivals. `remote` is false in solo,
  // where remoteOnly steps are dropped and remote* fields are ignored.
  const { remote } = useGame();
  const steps = STEPS
    .filter((s) => !s.remoteOnly || remote)
    .map((s) => remote ? {
      ...s,
      title: s.remoteTitle ?? s.title,
      body: s.remoteBody ?? s.body,
      highlight: s.remoteHighlight !== undefined ? (s.remoteHighlight || null) : s.highlight,
    } : s);
  const [step, setStep] = useState(0);
  const current = steps[step];
  const isLast = step === steps.length - 1;

  function handleNext() {
    if (isLast) {
      markSeen();
      onClose();
    } else {
      setStep(s => s + 1);
    }
  }

  function handleBack() {
    setStep(s => Math.max(0, s - 1));
  }

  function handleSkip() {
    markSeen();
    onClose();
  }

  function markSeen() {
    try { localStorage.setItem(TOUR_KEY, '1'); } catch (_) {}
  }

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 10000,
      padding: 24,
      backdropFilter: 'blur(2px)',
    }}>
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 18,
        padding: '36px 36px 28px',
        maxWidth: 480,
        width: '100%',
        position: 'relative',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
      }}>
        {/* Step counter */}
        <div style={{
          position: 'absolute', top: 18, right: 22,
          fontSize: 11, color: 'var(--text-dim)',
          fontFamily: 'monospace', letterSpacing: '0.5px',
        }}>
          {step + 1} / {steps.length}
        </div>

        {/* Icon */}
        <div style={{ marginBottom: 18, lineHeight: 1, color: 'var(--accent)' }}>
          <Glyph e={current.icon} size={46} />
        </div>

        {/* Title */}
        <div style={{
          fontSize: 20, fontWeight: 700, marginBottom: 14,
          lineHeight: 1.3, color: 'var(--text)',
        }}>
          {current.title}
        </div>

        {/* Body */}
        <div style={{
          fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.75,
          whiteSpace: 'pre-line', marginBottom: current.highlight ? 16 : 28,
          minHeight: 80,
        }}>
          {current.body}
        </div>

        {/* Highlight tag */}
        {current.highlight && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 14px', borderRadius: 20, marginBottom: 24,
            background: 'var(--accent-dim)',
            border: '1px solid var(--accent)',
            fontSize: 12, color: 'var(--accent)', fontWeight: 600,
          }}>
            Look for: {current.highlight} →
          </div>
        )}

        {/* Progress dots */}
        <div style={{ display: 'flex', gap: 5, marginBottom: 24, alignItems: 'center' }}>
          {steps.map((_, i) => (
            <div
              key={i}
              onClick={() => setStep(i)}
              style={{
                width: i === step ? 22 : 7,
                height: 7,
                borderRadius: 4,
                background: i === step
                  ? 'var(--accent)'
                  : i < step
                  ? 'var(--accent-dim)'
                  : 'var(--surface3)',
                transition: 'width 0.25s ease, background 0.2s',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            />
          ))}
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!isLast && (
            <button
              onClick={handleSkip}
              style={{
                background: 'none', border: 'none',
                color: 'var(--text-dim)', cursor: 'pointer',
                fontSize: 12, padding: '8px 10px', borderRadius: 8,
                marginRight: 'auto',
              }}
            >
              Skip tour
            </button>
          )}
          {step > 0 && (
            <button
              onClick={handleBack}
              className="btn"
              style={{ padding: '8px 16px', fontSize: 13 }}
            >
              ← Back
            </button>
          )}
          <button
            onClick={handleNext}
            className="btn btn-primary"
            style={{ padding: '9px 22px', fontSize: 13, fontWeight: 600, marginLeft: isLast ? 'auto' : 0 }}
          >
            {isLast ? "Let's Go!" : 'Next →'}
          </button>
        </div>
      </div>
    </div>
  );
}
