// Width of a Flights/week slider, in px. A fixed 110px was fine when launch was
// capped at 14/wk, but a short lane can now fit 60+ round trips and each step
// shrank to under 2px. Grow with the range (about 3.5px a step), keep short
// ranges compact, and stop before it crowds the rest of the controls row.
export function frequencySliderWidth(freqCap) {
  const steps = Math.max(1, Number(freqCap) || 1);
  return Math.round(Math.min(280, Math.max(110, 60 + steps * 3.5)));
}
