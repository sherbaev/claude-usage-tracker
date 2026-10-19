// Minimal Telegram Bot API client. Bot tokens are part of the request URL, so errors never include it.
const DEFAULT_BASE = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;

export class TelegramError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** @param {{ fetch?: typeof fetch, base?: string }} options */
export function createTelegramApi({ fetch: fetchImpl = globalThis.fetch, base = DEFAULT_BASE } = {}) {
  async function request(token, method, body) {
    const isForm = body instanceof FormData;
    let res;
    try {
      res = await fetchImpl(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: isForm ? undefined : { 'Content-Type': 'application/json' },
        body: isForm ? body : JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new TelegramError(`cannot reach Telegram (${error.cause?.code ?? error.name})`, 0);
    }
    const payload = await res.json().catch(() => ({}));
    if (!payload.ok) throw new TelegramError(String(payload.description ?? `HTTP ${res.status}`).slice(0, 200), payload.error_code ?? res.status);
    return payload.result;
  }

  return {
    call: (token, method, params) => request(token, method, params),
    /** setMyProfilePhoto needs a multipart upload of a JPG. */
    setProfilePhoto(token, jpg) {
      const form = new FormData();
      form.append('photo', JSON.stringify({ type: 'static', photo: 'attach://avatar' }));
      form.append('avatar', new Blob([jpg], { type: 'image/jpeg' }), 'avatar.jpg');
      return request(token, 'setMyProfilePhoto', form);
    },
  };
}
