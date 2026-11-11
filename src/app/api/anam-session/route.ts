import { NextResponse } from "next/server";

const AVATAR_MODEL = "cara-3";

/**
 * Creates an Anam session token with ElevenLabs agent settings.
 *
 * Fetches the ElevenLabs signed URL server-side, then passes it to
 * the Anam session token API via environment.elevenLabsAgentSettings.
 * The engine handles the ElevenLabs connection — the client just
 * streams the avatar video.
 */
export async function POST(request: Request) {
  const anamApiKey = process.env.ANAM_API_KEY;
  if (!anamApiKey) {
    return NextResponse.json(
      { error: "ANAM_API_KEY must be set" },
      { status: 500 }
    );
  }

  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenLabsApiKey) {
    return NextResponse.json(
      { error: "ELEVENLABS_API_KEY must be set" },
      { status: 500 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const { avatarId, agentId } = body;

  if (!avatarId) {
    return NextResponse.json(
      { error: "avatarId is required" },
      { status: 400 }
    );
  }
  if (!agentId) {
    return NextResponse.json(
      { error: "agentId is required" },
      { status: 400 }
    );
  }

  // Fetch ElevenLabs signed URL
  const elRes = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
    {
      headers: { "xi-api-key": elevenLabsApiKey },
    }
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
  const sessionTokenBody = {
    personaConfig: { avatarId, avatarModel: AVATAR_MODEL },
    environment: {
      elevenLabsAgentSettings: {
        signedUrl,
        agentId,
      },
      ...(process.env.ANAM_POD_NAME && {
        podName: process.env.ANAM_POD_NAME,
      }),
    },
  };
  console.log(
    "Creating session token:",
    `${anamApiUrl}/v1/auth/session-token`,
    JSON.stringify(sessionTokenBody, null, 2)
  );
  const anamRes = await fetch(`${anamApiUrl}/v1/auth/session-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anamApiKey}`,
    },
    body: JSON.stringify(sessionTokenBody),
  });

  if (!anamRes.ok) {
    const text = await anamRes.text();
    return NextResponse.json(
      { error: `Anam API error: ${anamRes.status} ${text}` },
      { status: anamRes.status }
    );
  }

  const data = await anamRes.json();

  // Debug: decode the JWT payload to check token type
  try {
    const payload = JSON.parse(
      Buffer.from(data.sessionToken.split(".")[1], "base64").toString()
    );
    console.log("Session token payload:", JSON.stringify(payload, null, 2));
  } catch {}

  return NextResponse.json({ sessionToken: data.sessionToken });
}
