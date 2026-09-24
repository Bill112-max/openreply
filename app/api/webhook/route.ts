import { NextRequest, NextResponse } from "next/server";
import {
  parseCommentEvents,
  verifyWebhookSignature,
} from "@/lib/meta/webhook";
import { processCommentEventsSynchronously } from "@/lib/meta/synchronous-webhook";


export async function GET(request: NextRequest) {
  console.log("[Webhook Sync] GET received", { url: request.url });
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const expectedToken = process.env.WEBHOOK_VERIFY_TOKEN;
  console.log("[Webhook Sync] Verifying Meta handshake", { mode, hasToken: Boolean(token), hasConfiguredToken: Boolean(expectedToken), hasChallenge: Boolean(challenge) });

  if (mode === "subscribe" && Boolean(expectedToken) && token === expectedToken && challenge) {
    console.log("[Webhook Sync] Meta handshake verified");
    return new NextResponse(challenge, { status: 200 });
  }

  console.error("[Webhook Sync] Meta handshake rejected");
  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 }
  );
}

export async function POST(request: NextRequest) {
  console.log("[Webhook Sync] POST received", { url: request.url });
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  console.log("[Webhook Sync] Verifying POST signature", { bodyLength: rawBody.length, hasSignature: Boolean(signature) });
  if (!verifyWebhookSignature(rawBody, signature)) {
    console.error("[Webhook Sync] Signature verification failed", {
      hadSignatureHeader: Boolean(signature),
      bodyLength: rawBody.length,
      bodyPreview: rawBody.slice(0, 200),
    });
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  try {
    const results = await processCommentEventsSynchronously(payload as Parameters<typeof parseCommentEvents>[0]);
    return NextResponse.json({ success: true, synchronous: true, results });
  } catch (error) {
    console.error("[Webhook Sync] POST processing failed", error);
    return NextResponse.json({ success: false, error: "Webhook processing failed" }, { status: 500 });
  }
}
