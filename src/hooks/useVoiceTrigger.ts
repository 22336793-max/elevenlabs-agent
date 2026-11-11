"use client";

import { useEffect, useRef } from "react";

/**
 * Starts Cian when the microphone picks up sound above a threshold, e.g.
 * someone switching on the wireless mic and speaking into it. No words need
 * to be recognised and it works offline.
 *
 * It only listens while `enabled` is true. Cian turns it off during a
 * conversation (so the mic is left to the call) and for a short cooldown
 * afterwards (so someone still speaking doesn't start a new one at once).
 *
 * `threshold` is on a 0–100 scale (0 = silence, 100 = as loud as possible).
 * `onLevel` reports the live level so the debug display can help calibrate.
 */
export function useVoiceTrigger(
  enabled: boolean,
  onVoice: () => void,
  options: {
    threshold: number;
    holdMs?: number;
    onLevel?: (level: number) => void;
    onBlocked?: (reason: string | null) => void;
  }
) {
  const { threshold, holdMs = 250 } = options;
  const onVoiceRef = useRef(onVoice);
  const onLevelRef = useRef(options.onLevel);
  const onBlockedRef = useRef(options.onBlocked);
  useEffect(() => {
    onVoiceRef.current = onVoice;
    onLevelRef.current = options.onLevel;
    onBlockedRef.current = options.onBlocked;
  });

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let fired = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let loudSince = 0;
    let blocked = false;

    const resumeOnGesture = () => {
      ctx?.resume().catch(() => {});
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: true, // ignore steady hiss from the receiver
            autoGainControl: false, // keep levels honest so the threshold means something
          },
        });
      } catch (err) {
        console.warn("Voice trigger: microphone unavailable", err);
        onBlockedRef.current?.("microphone blocked or not found");
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      ctx = new AudioContext();
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => {});
        if (ctx.state === "suspended") {
          // Chrome needs the kiosk flag (--autoplay-policy=no-user-gesture-required)
          // or one click/keypress before it lets a page listen.
          blocked = true;
          onBlockedRef.current?.("audio paused until a click (use the kiosk shortcut)");
          window.addEventListener("pointerdown", resumeOnGesture, { once: true });
          window.addEventListener("keydown", resumeOnGesture, { once: true });
        }
      }

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);

      timer = setInterval(() => {
        if (fired || !ctx || ctx.state !== "running") return;
        if (blocked) {
          blocked = false;
          onBlockedRef.current?.(null);
        }
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const db = 20 * Math.log10(rms || 1e-9); // 0 dB = full scale
        const level = Math.max(0, Math.min(100, ((db + 90) / 90) * 100));
        onLevelRef.current?.(Math.round(level));

        const now = performance.now();
        if (level >= threshold) {
          if (!loudSince) loudSince = now;
          if (now - loudSince >= holdMs) {
            fired = true;
            onVoiceRef.current();
          }
        } else {
          loudSince = 0;
        }
      }, 50);
    })();

    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("pointerdown", resumeOnGesture);
      window.removeEventListener("keydown", resumeOnGesture);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
    };
  }, [enabled, threshold, holdMs]);
}
