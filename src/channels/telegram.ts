import dns from 'dns';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// Mount point inside container for the group folder. Must match
// container-runner.ts containerPath for the group mount.
const CONTAINER_GROUP_PATH = '/workspace/group';
const ATTACHMENTS_SUBDIR = 'attachments';

// Replace unsafe filename chars with underscore; cap length.
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return cleaned.slice(0, 120) || 'file';
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  // IPv4-only HTTPS agent — reused for the bot client and for file downloads,
  // since the server has no IPv6 and Telegram's AAAA lookups would hang.
  private ipv4Agent: https.Agent = new https.Agent({
    lookup: (hostname, options, callback) =>
      dns.lookup(hostname, { ...options, family: 4 }, callback),
  });

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: {
          agent: this.ipv4Agent,
          compress: true,
        },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Helper: emit a non-text message with a placeholder (and optional
    // downloaded-attachment annotation) so the agent knows something was sent.
    const emitNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    // Download the Telegram file for `fileId`, save it under the group's
    // attachments/ directory, and return a placeholder string that includes
    // the in-container path so the agent can Read it. Falls back to the
    // bare placeholder if the download fails (e.g., >20MB files are not
    // accessible via the bot API, or no file_id is present).
    const withDownload = async (
      ctx: any,
      label: string,
      fileId: string | undefined,
      preferredName: string,
    ): Promise<string> => {
      const bare = `[${label}]`;
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group || !fileId) return bare;

      try {
        const containerPath = await this.downloadAttachment(
          fileId,
          preferredName,
          group.folder,
        );
        if (!containerPath) return bare;
        return `[${label} — saved to ${containerPath}]`;
      } catch (err) {
        logger.error(
          { err, fileId, groupFolder: group.folder },
          'Failed to download Telegram attachment',
        );
        return bare;
      }
    };

    this.bot.on('message:photo', async (ctx) => {
      // Photos are an array of sizes, smallest→largest. Use the largest.
      const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
      const preferred = `photo_${ctx.message.message_id}.jpg`;
      const placeholder = await withDownload(
        ctx,
        'Photo',
        photo?.file_id,
        preferred,
      );
      emitNonText(ctx, placeholder);
    });
    this.bot.on('message:video', async (ctx) => {
      const vid = ctx.message.video;
      const preferred = vid?.file_name || `video_${ctx.message.message_id}.mp4`;
      const placeholder = await withDownload(
        ctx,
        'Video',
        vid?.file_id,
        preferred,
      );
      emitNonText(ctx, placeholder);
    });
    this.bot.on('message:voice', async (ctx) => {
      const voice = ctx.message.voice;
      const preferred = `voice_${ctx.message.message_id}.ogg`;
      const placeholder = await withDownload(
        ctx,
        'Voice message',
        voice?.file_id,
        preferred,
      );
      emitNonText(ctx, placeholder);
    });
    this.bot.on('message:audio', async (ctx) => {
      const audio = ctx.message.audio;
      const preferred =
        audio?.file_name || `audio_${ctx.message.message_id}.mp3`;
      const placeholder = await withDownload(
        ctx,
        'Audio',
        audio?.file_id,
        preferred,
      );
      emitNonText(ctx, placeholder);
    });
    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const fileName = doc?.file_name || 'file';
      const placeholder = await withDownload(
        ctx,
        `Document: ${fileName}`,
        doc?.file_id,
        fileName,
      );
      emitNonText(ctx, placeholder);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      emitNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => emitNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => emitNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  /**
   * Resolves `fileId` via Telegram's getFile endpoint, downloads the resulting
   * file into `groups/<groupFolder>/attachments/`, and returns the in-container
   * path (e.g. `/workspace/group/attachments/<ts>_<name>`) where the agent can
   * Read it. Returns null if the download can't be completed.
   *
   * Telegram's Bot API only serves files up to 20MB; larger files cannot be
   * downloaded this way and will return null.
   */
  private async downloadAttachment(
    fileId: string,
    preferredName: string,
    groupFolder: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    // Ask Telegram for the server-side file path.
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) {
      logger.warn({ fileId }, 'Telegram getFile returned no file_path');
      return null;
    }

    // Build a safe local filename, preferring the server-side extension.
    const serverExt = path.extname(file.file_path);
    const preferredExt = path.extname(preferredName);
    const ext = serverExt || preferredExt || '';
    const baseNoExt = path.basename(preferredName, preferredExt) || 'file';
    const safeBase = sanitizeFileName(baseNoExt);
    const fileName = `${Date.now()}_${safeBase}${ext}`;

    const attachmentsDir = path.join(
      GROUPS_DIR,
      groupFolder,
      ATTACHMENTS_SUBDIR,
    );
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const hostPath = path.join(attachmentsDir, fileName);

    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

    await new Promise<void>((resolve, reject) => {
      const req = https.get(url, { agent: this.ipv4Agent }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Telegram file download HTTP ${res.statusCode}`));
          return;
        }
        const out = fs.createWriteStream(hostPath);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', (e) => {
          fs.unlink(hostPath, () => reject(e));
        });
      });
      req.on('error', reject);
    });

    logger.info(
      { hostPath, fileId, bytes: fs.statSync(hostPath).size },
      'Downloaded Telegram attachment',
    );
    return `${CONTAINER_GROUP_PATH}/${ATTACHMENTS_SUBDIR}/${fileName}`;
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
