import React, { useState } from 'react';

const FLAG = 'space365.onboarded';

const STEPS = [
  {
    title: 'This is your office',
    body: 'Every building is a real Teams channel — the brighter it glows, the busier the conversation. Walk around with WASD, orbit with the mouse.',
    place: 'center' as const,
  },
  {
    title: 'Activity lives here',
    body: 'The feed shows the latest channel activity and bursts. Click any row to fast-travel straight to that room.',
    place: 'left' as const,
  },
  {
    title: 'Find your team',
    body: 'Search zones and rooms by name, then press Enter to teleport. The minimap in the corner works too.',
    place: 'top' as const,
  },
];

export function shouldOnboard(): boolean {
  try {
    return localStorage.getItem(FLAG) === null;
  } catch {
    return false;
  }
}

/** First-visit 3-step tour (P5.4). Static positioning; reduced-motion friendly. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);

  const finish = () => {
    try {
      localStorage.setItem(FLAG, new Date().toISOString());
    } catch {
      /* private mode */
    }
    onDone();
  };

  const s = STEPS[step];
  return (
    <div className="onboard-backdrop">
      <div className={`panel onboard-card onboard-${s.place}`}>
        <div className="onboard-step dim">
          {step + 1} / {STEPS.length}
        </div>
        <h2>{s.title}</h2>
        <p>{s.body}</p>
        <div className="onboard-actions">
          <button className="ghost-btn" onClick={finish}>
            Skip
          </button>
          {step < STEPS.length - 1 ? (
            <button className="primary-btn" onClick={() => setStep(step + 1)}>
              Next
            </button>
          ) : (
            <button className="primary-btn" onClick={finish}>
              Let's go
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
