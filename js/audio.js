/* ============================================
   Tricorder Audio Engine
   Sci-fi sound effects using Web Audio API
   ============================================ */

const TricorderAudio = (() => {
    let ctx = null;
    let enabled = true;
    let _userInteracted = false;

    // Browsers block AudioContext before first user gesture.
    // Defer creation until we know the user has interacted.
    function markInteracted() {
        if (_userInteracted) return;
        _userInteracted = true;
        document.removeEventListener('click', markInteracted, true);
        document.removeEventListener('touchstart', markInteracted, true);
        document.removeEventListener('keydown', markInteracted, true);
    }
    document.addEventListener('click', markInteracted, true);
    document.addEventListener('touchstart', markInteracted, true);
    document.addEventListener('keydown', markInteracted, true);

    function getCtx() {
        if (!_userInteracted) return null;
        if (!ctx) {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    function playTone(freq, duration, type = 'sine', volume = 0.1) {
        if (!enabled) return;
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
        } catch (e) { /* silent fail */ }
    }

    return {
        // Classic Star Trek chirp
        chirp() {
            playTone(1200, 0.08, 'sine', 0.08);
            setTimeout(() => playTone(1600, 0.12, 'sine', 0.06), 80);
        },

        // Button press
        tap() {
            playTone(800, 0.05, 'sine', 0.05);
        },

        // Module switch
        switch() {
            playTone(600, 0.06, 'sine', 0.06);
            setTimeout(() => playTone(900, 0.08, 'sine', 0.05), 60);
        },

        // Scan start
        scanStart() {
            for (let i = 0; i < 5; i++) {
                setTimeout(() => playTone(400 + i * 200, 0.1, 'sine', 0.05), i * 80);
            }
        },

        // Scan complete
        scanComplete() {
            playTone(1000, 0.1, 'sine', 0.06);
            setTimeout(() => playTone(1200, 0.1, 'sine', 0.06), 100);
            setTimeout(() => playTone(1500, 0.15, 'sine', 0.06), 200);
        },

        // Error / alert
        alert() {
            playTone(300, 0.2, 'square', 0.06);
            setTimeout(() => playTone(300, 0.2, 'square', 0.06), 300);
        },

        // Boot sequence
        boot() {
            const notes = [200, 300, 400, 500, 600, 800, 1000, 1200];
            notes.forEach((freq, i) => {
                setTimeout(() => playTone(freq, 0.15, 'sine', 0.04), i * 120);
            });
        },

        // Voice activation
        voiceOn() {
            playTone(500, 0.08, 'sine', 0.06);
            setTimeout(() => playTone(700, 0.1, 'sine', 0.06), 80);
        },

        // Voice deactivation
        voiceOff() {
            playTone(700, 0.08, 'sine', 0.06);
            setTimeout(() => playTone(500, 0.1, 'sine', 0.06), 80);
        },

        // Message received
        message() {
            playTone(880, 0.08, 'sine', 0.05);
            setTimeout(() => playTone(1100, 0.12, 'sine', 0.04), 100);
        },

        // Ambient scanner hum (continuous)
        startHum() {
            if (!enabled) return null;
            try {
                const c = getCtx();
                if (!c) return null;
                const osc = c.createOscillator();
                const gain = c.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(60, c.currentTime);
                gain.gain.setValueAtTime(0.015, c.currentTime);
                osc.connect(gain);
                gain.connect(c.destination);
                osc.start();
                return { osc, gain };
            } catch (e) { return null; }
        },

        stopHum(hum) {
            if (hum) {
                try {
                    hum.gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
                    hum.osc.stop(ctx.currentTime + 0.3);
                } catch (e) { /* silent */ }
            }
        },

        // Haptic feedback (vibration)
        haptic(pattern = [15]) {
            if (navigator.vibrate) {
                navigator.vibrate(pattern);
            }
        },

        toggle() {
            enabled = !enabled;
            if (typeof TricorderLLM !== 'undefined') {
                TricorderLLM.saveSettings({ sfx: enabled });
            }
            return enabled;
        },

        syncFromSettings() {
            if (typeof TricorderLLM !== 'undefined') {
                enabled = TricorderLLM.settings.sfx !== false;
            }
        },

        get isEnabled() { return enabled; }
    };
})();
