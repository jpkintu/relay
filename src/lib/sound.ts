// Notification sounds, generated with the Web Audio API (no audio files).
// Browsers only allow audio after the user has interacted with the page, so
// unlockAudio() runs on the first tap/click.

export type Tone = 'new' | 'update' | 'alert';

let context: AudioContext | null = null;

export function unlockAudio() {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    context ??= new Ctor();
    if (context.state === 'suspended') void context.resume();
  } catch {
    // No audio on this device; notifications still show.
  }
}

// Each note: [frequency Hz, start s, length s].
const PATTERNS: Record<Tone, [number, number, number][]> = {
  // A bright rising two-note chime: something new for the kitchen.
  new: [
    [880, 0, 0.16],
    [1318.5, 0.14, 0.32],
  ],
  // One soft ping: an update on something you follow.
  update: [[987.8, 0, 0.22]],
  // Three short beeps: needs action.
  alert: [
    [740, 0, 0.12],
    [740, 0.18, 0.12],
    [740, 0.36, 0.2],
  ],
};

export function playTone(tone: Tone) {
  if (!context || context.state !== 'running') return;
  const now = context.currentTime;
  for (const [frequency, start, length] of PATTERNS[tone] ?? PATTERNS.update) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(0.25, now + start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + length);
    osc.connect(gain).connect(context.destination);
    osc.start(now + start);
    osc.stop(now + start + length + 0.05);
  }
}

// The loudest tone wins when several notifications arrive together.
export function strongestTone(tones: string[]): Tone | null {
  if (tones.includes('alert')) return 'alert';
  if (tones.includes('new')) return 'new';
  return tones.length ? 'update' : null;
}
