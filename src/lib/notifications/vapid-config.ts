import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * The env fallback, read when the admin Settings panel has no key pair stored.
 *
 * `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` are the only
 * names. Six `WEB_PUSH_*` aliases and a `NEXT_PUBLIC_VAPID_PUBLIC_KEY` one
 * used to sit behind them; none was ever on the compose `environment:`
 * whitelist, so under the bundled stack a value set under any of those names
 * could not reach this process, and none appeared in `.env.example`,
 * `.env.production.example` or the env manifest. They read as an escape hatch
 * that had never been open.
 */
function fromEnv(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export async function getVapidConfig(): Promise<VapidConfig | null> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        webPushVapidPublicKey: true,
        webPushVapidPrivateKeyEncrypted: true,
        webPushVapidSubject: true,
      },
    });

    if (
      settings?.webPushVapidPublicKey &&
      settings?.webPushVapidPrivateKeyEncrypted &&
      settings?.webPushVapidSubject
    ) {
      return {
        publicKey: settings.webPushVapidPublicKey,
        privateKey: decrypt(settings.webPushVapidPrivateKeyEncrypted),
        subject: settings.webPushVapidSubject,
      };
    }
  } catch {
    getEvent()?.addWarning("Failed to load Web Push config from database");
  }

  return fromEnv();
}
