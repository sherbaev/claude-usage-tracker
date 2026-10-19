// Encrypts bot tokens at rest (AES-256-GCM). The key comes from TELEGRAM_SECRET, or a key file next to
// the database, so a leaked database dump alone does not expose the bots.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_FILE = 'secret.key';

export function createSecretBox(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error(`secret key must be ${KEY_BYTES} bytes`);
  return {
    seal(text) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`;
    },
    open(sealed) {
      const [version, payload] = String(sealed).split(':');
      if (version !== VERSION || !payload) throw new Error('unknown sealed format');
      const raw = Buffer.from(payload, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    },
  };
}

/** 32-byte key: derived from `secret` if given, else read from (or created in) the data directory. */
export function loadSecretKey({ dataDir, secret }) {
  if (secret) return createHash('sha256').update(secret).digest();
  const file = join(dataDir, KEY_FILE);
  try {
    return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(file, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  return key;
}
