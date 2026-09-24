import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { parseCommentEvents, type WebhookCommentEvent } from "@/lib/meta/webhook";
import { sendCommentReply, sendPrivateReply } from "@/lib/meta/client";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

type SyncConfig = {
  instagramAccountId: string;
  accessToken: string;
  keywords: string[];
  privateReply: string;
  publicReply?: string;
};

function envConfig(): SyncConfig | null {
  const accessToken = process.env.WEBHOOK_ACCESS_TOKEN;
  const privateReply = process.env.WEBHOOK_PRIVATE_REPLY;
  if (!accessToken || !privateReply) return null;

  return {
    instagramAccountId: process.env.WEBHOOK_INSTAGRAM_ACCOUNT_ID ?? "*",
    accessToken,
    keywords: (process.env.WEBHOOK_KEYWORDS ?? "").split(",").map((keyword) => keyword.trim()).filter(Boolean),
    privateReply,
    publicReply: process.env.WEBHOOK_PUBLIC_REPLY || undefined,
  };
}

async function configsForEvent(event: WebhookCommentEvent): Promise<SyncConfig[]> {
  const configured = envConfig();
  if (configured && (configured.instagramAccountId === "*" || configured.instagramAccountId === event.instagramAccountId)) {
    console.log("[Webhook Sync] Using environment configuration", { instagramAccountId: event.instagramAccountId, keywordCount: configured.keywords.length, hasPublicReply: Boolean(configured.publicReply) });
    return [configured];
  }

  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: event.instagramAccountId },
    select: {
      instagramId: true,
      accessToken: true,
      provider: true,
      automations: {
        where: { isActive: true },
        select: { keywords: true, matchAnyWord: true, dmMessage: true, publicReplyEnabled: true, publicReplyMessage: true },
      },
    },
  });
  if (!account || account.provider !== "META") return [];

  const accessToken = decryptToken(account.accessToken);
  return account.automations.map((automation) => ({
    instagramAccountId: account.instagramId,
    accessToken,
    keywords: automation.matchAnyWord ? [] : automation.keywords,
    privateReply: automation.dmMessage,
    publicReply: automation.publicReplyEnabled ? automation.publicReplyMessage ?? undefined : undefined,
  }));
}

function matches(event: WebhookCommentEvent, config: SyncConfig): boolean {
  return config.keywords.length === 0 || matchKeywords(event.commentText, config.keywords, true).matched;
}

/**
 * Required no-worker keys: WEBHOOK_VERIFY_TOKEN, WEBHOOK_ACCESS_TOKEN,
 * WEBHOOK_KEYWORDS, WEBHOOK_PRIVATE_REPLY, and WEBHOOK_INSTAGRAM_ACCOUNT_ID.
 * WEBHOOK_PUBLIC_REPLY is optional. Database campaigns are the fallback when
 * the access token and private reply are not configured in the environment.
 */
export async function processCommentEventsSynchronously(payload: Parameters<typeof parseCommentEvents>[0]) {
  const events = parseCommentEvents(payload);
  console.log("[Webhook Sync] Parsed comment events", { count: events.length });
  const results: Array<{ commentId: string; status: string }> = [];

  for (const event of events) {
    const configs = await configsForEvent(event);
    for (const config of configs) {
      if (!matches(event, config)) {
        console.log("[Webhook Sync] Keyword did not match", { commentId: event.commentId });
        continue;
      }

      try {
        if (config.publicReply) {
          console.log("[Webhook Sync] Calling Meta public comment reply", { commentId: event.commentId });
          await sendCommentReply(config.accessToken, event.commentId, config.publicReply);
        }
        console.log("[Webhook Sync] Calling Meta private reply", { commentId: event.commentId });
        await sendPrivateReply(config.accessToken, event.instagramAccountId, event.commentId, config.privateReply);
        results.push({ commentId: event.commentId, status: "sent" });
        console.log("[Webhook Sync] Comment replies sent", { commentId: event.commentId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Webhook Sync] Meta Graph API request failed", { commentId: event.commentId, instagramAccountId: event.instagramAccountId, error: message, details: error });
        results.push({ commentId: event.commentId, status: "failed" });
      }
    }
  }

  return results;
}