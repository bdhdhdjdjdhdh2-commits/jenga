class WoodAudioSynthesizer {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabled = true;
  private lastImpactTime = 0;
  private lastSlideTime = 0;

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public unlock(): void {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.noiseBuffer = this.createNoiseBuffer(this.ctx);
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 0.25);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /**
   * Procedural hardwood knock/clack scaled by impact velocity.
   */
  public playWoodImpact(intensity: number, pitchOffset = 0): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    if (now - this.lastImpactTime < 0.028) return;
    this.lastImpactTime = now;

    const clamped = Math.min(1, Math.max(0.06, intensity));
    const gainLevel = clamped * 0.32;

    // 1. Short percussive wood resonance (two harmonic modes)
    const baseFreq = (255 + Math.random() * 55 + pitchOffset) * (0.95 + clamped * 0.08);
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();

    osc1.type = 'triangle';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(baseFreq, now);
    osc1.frequency.exponentialRampToValueAtTime(baseFreq * 0.68, now + 0.065);

    osc2.frequency.setValueAtTime(baseFreq * 2.38, now);
    osc2.frequency.exponentialRampToValueAtTime(baseFreq * 1.65, now + 0.045);

    oscGain.gain.setValueAtTime(0.001, now);
    oscGain.gain.linearRampToValueAtTime(gainLevel, now + 0.004);
    oscGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.095);

    osc1.connect(oscGain);
    osc2.connect(oscGain);
    oscGain.connect(this.ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.1);
    osc2.stop(now + 0.1);

    // 2. Crisp contact transient burst (bandpass-filtered noise)
    if (this.noiseBuffer && clamped > 0.15) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1150 + Math.random() * 350, now);
      filter.Q.setValueAtTime(2.6, now);

      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(gainLevel * 0.65, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.025);

      noise.connect(filter);
      filter.connect(nGain);
      nGain.connect(this.ctx.destination);

      noise.start(now);
      noise.stop(now + 0.03);
    }
  }

  /**
   * Subtle wooden sliding grain tick while pulling a block out.
   */
  public playWoodSlide(speed: number): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running' || !this.noiseBuffer) return;

    const now = this.ctx.currentTime;
    if (now - this.lastSlideTime < 0.07) return;
    this.lastSlideTime = now;

    const vol = Math.min(0.065, Math.max(0.01, speed * 0.015));
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(750 + Math.random() * 300, now);
    filter.Q.setValueAtTime(4.2, now);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.055);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    noise.start(now);
    noise.stop(now + 0.06);
  }

  /**
   * Warm marimba chime when a block is cleanly extracted.
   */
  public playExtractChime(): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25]; // C5 -> E5
    notes.forEach((freq, idx) => {
      if (!this.ctx) return;
      const t = now + idx * 0.065;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.14, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.24);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.26);
    });
  }

  /**
   * Warm wooden triad on successful turn completion.
   */
  public playPlaceSuccess(): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    const notes = [392.0, 493.88, 587.33]; // G4, B4, D5
    notes.forEach((freq, idx) => {
      if (!this.ctx) return;
      const t = now + idx * 0.05;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.11, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.32);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.34);
    });
  }

  /**
   * Dramatic low wooden thud when slow-motion collapse begins.
   */
  public playCollapseCue(): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(145, now);
    osc.frequency.exponentialRampToValueAtTime(52, now + 0.42);

    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.48);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.5);
  }
}

export const woodAudio = new WoodAudioSynthesizer();
