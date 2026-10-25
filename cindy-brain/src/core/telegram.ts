// Telegram channel adapter: outbound notify + inbound webhook command handling.

export interface Channel {
  send(text: string, opts?: { chatId?: string }): Promise<void>;
  receive(update: unknown): Promise<void>;
}

export class TelegramChannel implements Channel {
  constructor(
    private env: {
      TELEGRAM_BOT_TOKEN?: string;
      TELEGRAM_CHAT_ID?: string;
    },
    private handler: (text: string, chatId: string) => Promise<void>,
  ) {}

  async send(text: string, opts?: { chatId?: string }): Promise<void> {
    const token = this.env.TELEGRAM_BOT_TOKEN;
    const chatId = opts?.chatId ?? this.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; // Telegram not configured — skip silently
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  }

  async receive(update: unknown): Promise<void> {
    const u = update as {
      message?: { text?: string; chat?: { id?: number } };
    };
    const text = u.message?.text;
    const chatId = u.message?.chat?.id ? String(u.message.chat.id) : undefined;
    if (!text || !chatId) return;
    await this.handler(text, chatId);
  }
}

export function verifyTelegramWebhook(req: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  const header = req.headers.get("x-telegram-bot-api-secret-token");
  return header === expectedToken;
}
