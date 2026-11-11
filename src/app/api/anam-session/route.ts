import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

// Cian's avatar only supports cara-3. Override with ANAM_AVATAR_MODEL if the avatar changes.
const AVATAR_MODEL = process.env.ANAM_AVATAR_MODEL || "cara-3";

/**
 * Creates an Anam session token for Cian.
 *
 * Fetches an ElevenLabs signed URL server-side, then passes it to the Anam
 * session token API via environment.elevenLabsAgentSettings. The Anam engine
 * handles the ElevenLabs connection; the browser only streams the avatar.
 *
 * The avatar and agent always come from the server's environment variables
 * (PERSONA_1_AVATAR_ID / PERSONA_1_AGENT_ID), never from the browser.
 *
 * If KIOSK_SECRET is set, the request must carry the same value as `key`
 * (the kiosk passes it from its URL, e.g. https://your-app.vercel.app/?key=...).
 * This stops anyone who finds the public address from spending Anam and
 * ElevenLabs credit. If KIOSK_SECRET is not set, the check is skipped.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));

  const kioskSecret = process.env.KIOSK_SECRET;
  if (kioskSecret && !secretsMatch(String(body?.key ?? ""), kioskSecret)) {
    return NextResponse.json(
      { error: "Locked: add ?key=<your KIOSK_SECRET> to the address" },
      { status: 401 }
    );
  }

  const anamApiKey = process.env.ANAM_API_KEY;
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  const avatarId = process.env.PERSONA_1_AVATAR_ID;
  const agentId = process.env.PERSONA_1_AGENT_ID;

  const missing = [
    !anamApiKey && "ANAM_API_KEY",
    !elevenLabsApiKey && "ELEVENLABS_API_KEY",
    !avatarId && "PERSONA_1_AVATAR_ID",
    !agentId && "PERSONA_1_AGENT_ID",
  ].filter(Boolean);
  if (missing.length) {
    return NextResponse.json(
      { error: `Missing environment variables: ${missing.join(", ")}` },
      { status: 500 }
    );
  }

  // Fetch ElevenLabs signed URL
  const elRes = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId!)}`,
    { headers: { "xi-api-key": elevenLabsApiKey! } }
  );

  if (!elRes.ok) {
    const text = await elRes.text();
    return NextResponse.json(
      { error: `ElevenLabs API error: ${elRes.status} ${text}` },
      { status: elRes.status }
    );
  }

  const { signed_url: signedUrl } = await elRes.json();

  // Create Anam session token with ElevenLabs agent settings
  const anamApiUrl = process.env.ANAM_API_URL || "https://lab.anam.ai";
  const anamRes = await fetch(`${anamApiUrl}/v1/auth/session-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anamApiKey}`,
    },
    body: JSON.stringify({
      personaConfig: { avatarId, avatarModel: AVATAR_MODEL },
      environment: {
        elevenLabsAgentSettings: { signedUrl, agentId },
        ...(process.env.ANAM_POD_NAME && {
          podName: process.env.ANAM_POD_NAME,
        }),
      },
    }),
  });

  if (!anamRes.ok) {
    const text = await anamRes.text();
    return NextResponse.json(
      { error: `Anam API error: ${anamRes.status} ${text}` },
      { status: anamRes.status }
    );
  }

  const data = await anamRes.json();
  return NextResponse.json({ sessionToken: data.sessionToken });
}

function secretsMatch(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
