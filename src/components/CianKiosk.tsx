/**
 * CianKiosk: the full-screen view projected onto Cian's mask.
 *
 * Black screen with no visible interface. A conversation starts when:
 *   - someone says "hello" (Chrome speech recognition, while idle)
 *   - the consent button is pressed (Makey Makey sends Space)
 *   - the screen is clicked (handy for testing with a mouse)
 * Space or a click during a conversation ends it.
 *
 * Optional settings in the address, e.g. /?key=abc&zoom=1.2&y=-5:
 *   key   the KIOSK_SECRET set in Vercel (required if one is set)
 *   zoom  scale the face up or down (default 1)
 *   x, y  nudge the face sideways / up-down, in % of the screen (default 0)
 *   flip  mirror the image for the 45° mirror: h, v or hv (default none)
 *   fit   cover (fill the screen, default) or contain (show whole frame)
 *   max   end a conversation after this many minutes (default 15)
 *   debug show a small status line in the corner (debug=1)
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnamEvent, createClient, type AnamClient } from "@anam-ai/js-sdk";
import { useHelloTrigger } from "@/hooks/useHelloTrigger";

type Status = "idle" | "connecting" | "connected" | "error";

type Settings = {
  key: string;
  zoom: number;
  x: number;
  y: number;
  flip: string;
  fit: "cover" | "contain";
  maxMinutes: number;
  debug: boolean;
};

const DEFAULTS: Settings = {
  key: "",
  zoom: 1,
  x: 0,
  y: 0,
  flip: "",
  fit: "cover",
  maxMinutes: 15,
  debug: false,
};

const PRESS_LOCKOUT_MS = 1000; // a noisy button contact can fire several times
const ERROR_RESET_MS = 8000; // after an error, go back to listening

export default function CianKiosk() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);

  const statusRef = useRef<Status>("idle");
  const clientRef = useRef<AnamClient | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastPressRef = useRef(0);
  const settingsRef = useRef<Settings>(DEFAULTS);

  const setBoth = (s: Status) => {
    statusRef.current = s;
    setStatus(s);
  };

  // Read settings from the address once, in the browser.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const num = (name: string, fallback: number) => {
      const v = parseFloat(p.get(name) ?? "");
      return Number.isFinite(v) ? v : fallback;
    };
    const s: Settings = {
      key: p.get("key") ?? "",
      zoom: num("zoom", DEFAULTS.zoom),
      x: num("x", DEFAULTS.x),
      y: num("y", DEFAULTS.y),
      flip: (p.get("flip") ?? "").toLowerCase(),
      fit: p.get("fit") === "contain" ? "contain" : "cover",
      maxMinutes: num("max", DEFAULTS.maxMinutes),
      debug: p.get("debug") === "1",
    };
    settingsRef.current = s;
    setSettings(s);
  }, []);

  const cleanUp = useCallback(() => {
    clearTimeout(maxTimerRef.current);
    clientRef.current = null;
  }, []);

  const stop = useCallback(async () => {
    const client = clientRef.current;
    cleanUp();
    setBoth("idle");
    try {
      await client?.stopStreaming();
    } catch {}
  }, [cleanUp]);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle") return;
    setBoth("connecting");
    setError(null);

    try {
      const res = await fetch("/api/anam-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: settingsRef.current.key }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Session request failed (${res.status})`);
      }
      const { sessionToken } = await res.json();

      const client = createClient(sessionToken, {
        ...(process.env.NEXT_PUBLIC_ANAM_API_URL && {
          api: { baseUrl: process.env.NEXT_PUBLIC_ANAM_API_URL },
        }),
      });
      clientRef.current = client;

      client.addListener(AnamEvent.CONNECTION_CLOSED, () => {
        if (clientRef.current !== client) return; // already stopped by us
        cleanUp();
        setBoth("idle");
      });

      await client.streamToVideoElement("avatar-video");
      if (clientRef.current !== client) return; // stopped while connecting

      setBoth("connected");
      const maxMs = settingsRef.current.maxMinutes * 60_000;
      if (maxMs > 0) maxTimerRef.current = setTimeout(stop, maxMs);
    } catch (err) {
      console.error("Start error:", err);
      cleanUp();
      setError(err instanceof Error ? err.message : String(err));
      setBoth("error");
    }
  }, [cleanUp, stop]);

  // One press (button, Space or click): start when idle, end when talking.
  const press = useCallback(() => {
    const now = Date.now();
    if (now - lastPressRef.current < PRESS_LOCKOUT_MS) return;
    lastPressRef.current = now;

    const s = statusRef.current;
    if (s === "idle") start();
    else if (s === "connected") stop();
    else if (s === "error") {
      setBoth("idle");
      setError(null);
    }
  }, [start, stop]);

  // Makey Makey consent button sends Space.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      e.preventDefault();
      press();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  // Saying "hello" starts a conversation, only while idle.
  useHelloTrigger(status === "idle", start);

  // After an error, quietly go back to listening.
  useEffect(() => {
    if (status !== "error") return;
    const t = setTimeout(() => {
      setError(null);
      setBoth("idle");
    }, ERROR_RESET_MS);
    return () => clearTimeout(t);
  }, [status]);

  // Keep the screen awake while the kiosk page is open.
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
    };
    const acquire = async () => {
      try {
        lock = (await nav.wakeLock?.request("screen")) ?? null;
      } catch {}
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") acquire();
    };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release().catch(() => {});
    };
  }, []);

  // End the session if the page is closed or reloaded.
  useEffect(() => {
    return () => {
      clientRef.current?.stopStreaming().catch(() => {});
    };
  }, []);

  const flipX = settings.flip.includes("h") ? -1 : 1;
  const flipY = settings.flip.includes("v") ? -1 : 1;

  return (
    <main
      className="fixed inset-0 bg-black overflow-hidden select-none"
      style={{ cursor: "none" }}
      onClick={press}
    >
      <video
        id="avatar-video"
        autoPlay
        playsInline
        className="absolute inset-0 w-full h-full bg-black transition-opacity duration-700 ease-out"
        style={{
          objectFit: settings.fit,
          opacity: status === "connected" ? 1 : 0,
          transform: `translate(${settings.x}%, ${settings.y}%) scale(${settings.zoom * flipX}, ${settings.zoom * flipY})`,
        }}
      />

      {status === "error" && error && (
        <p className="absolute bottom-4 left-4 right-4 text-xs text-white/40 font-mono">
          {error}
        </p>
      )}

      {settings.debug && (
        <p className="absolute top-4 left-4 text-xs text-white/50 font-mono">
          {status === "idle" ? "listening for hello" : status}
        </p>
      )}
    </main>
  );
}
