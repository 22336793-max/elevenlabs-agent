"use client";

import { useEffect, useRef } from "react";

/**
 * Listens for someone saying "hello" and calls onHello.
 *
 * Uses Chrome's built-in speech recognition, so it needs Chrome and an
 * internet connection. It only listens while `enabled` is true: Cian turns
 * it off during a conversation, so the mic is left to the call and a
 * "hello" mid-story does nothing.
 */
export function useHelloTrigger(enabled: boolean, onHello: () => void) {
  const onHelloRef = useRef(onHello);
  useEffect(() => {
    onHelloRef.current = onHello;
  }, [onHello]);

  useEffect(() => {
    if (!enabled) return;

    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) {
      console.warn("Speech recognition not available (use Chrome). Hello trigger is off.");
      return;
    }

    let stopped = false;
    let fired = false;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;

    const rec = new SR();
    rec.lang = "en-IE";
    rec.continuous = true;
    rec.interimResults = true; // react the moment "hello" is heard

    rec.onresult = (e) => {
      if (fired) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const heard = e.results[i][0].transcript.toLowerCase();
        if (/\b(hello|hallo|hullo|helo)\b/.test(heard)) {
          fired = true;
          onHelloRef.current();
          return;
        }
      }
    };

    // Chrome stops listening after silence or a time limit, so restart quietly.
    rec.onend = () => {
      if (stopped) return;
      restartTimer = setTimeout(() => {
        try {
          rec.start();
        } catch {}
      }, 300);
    };

    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        stopped = true;
        console.warn("Microphone blocked, so the hello trigger is off.");
      }
      // other errors (no-speech, network, aborted) fall through to onend and restart
    };

    try {
      rec.start();
    } catch {}

    return () => {
      stopped = true;
      clearTimeout(restartTimer);
      try {
        rec.abort();
      } catch {}
    };
  }, [enabled]);
}

// Minimal types: TypeScript's DOM library doesn't ship the Web Speech API.
type SpeechRecognitionCtor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: {
    resultIndex: number;
    results: ArrayLike<ArrayLike<{ transcript: string }>>;
  }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  abort(): void;
};
