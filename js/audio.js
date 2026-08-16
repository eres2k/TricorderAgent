/* ============================================
   Tricorder Audio
   ------------------------------------------------------------------
   Three synthesised UI sounds — sent, done, error — built from oscillators so
   there are no audio files to ship and nothing to fetch at runtime.

   This used to carry a dozen more: boot chimes, scanner sweeps, an ambient
   hum, and voice-mode cues left over from a speech feature this build does
   not have. None of them had a call site. What survives is what app.js
   actually plays.

   The volume ceiling is deliberately low. This is punctuation, not a score.
   ============================================ */

const TricorderAudio = (() => {
    let ctx = null;
    let interacted = false;

    // Browsers refuse to start an AudioContext before the first user gesture,
    // and constructing one anyway leaves a suspended context that never
    // recovers. Wait for the gesture, then build it lazily.
    function markInteracted() {
        interacted = true;
        for (const ev of ['click', 'touchstart', 'keydown']) {
            document.removeEventListener(ev, markInteracted, true);
        }
    }
    for (const ev of ['click', 'touchstart', 'keydown']) {
        document.addEventListener(ev, markInteracted, true);
    }

    function getCtx() {
        if (!interacted) return null;
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    // One note. Every sound below is one or two of these.
    function tone(freq, duration, volume = 0.05, type = 'sine') {
        try {
            const c = getCtx();
            if (!c) return;
            const osc = c.createOscillator();
            const gain = c.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, c.currentTime);
            gain.gain.setValueAtTime(volume, c.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
            osc.connect(gain);
            gain.connect(c.destination);
            osc.start();
            osc.stop(c.currentTime + duration);
        } catch { /* sound is cosmetic — never let it surface as an error */ }
    }

    return {
        // Message sent.
        tap() {
            tone(820, 0.05, 0.045);
        },

        // Reply finished — rising pair.
        message() {
            tone(880, 0.08, 0.045);
            setTimeout(() => tone(1180, 0.12, 0.035), 95);
        },

        // Something failed — flat repeat, deliberately less pleasant.
        alert() {
            tone(320, 0.18, 0.05, 'triangle');
            setTimeout(() => tone(320, 0.18, 0.05, 'triangle'), 260);
        },
    };
})();
