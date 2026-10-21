// When Claude Desktop, claude.ai (in a Chromium browser) and the Claude Chrome extension were last used on this
// device: the newest write in each one's own local storage. Only file times are read, never contents. The
// server uses it to tell which device plan usage outside Claude Code came from.
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// "Claude" in the Chrome Web Store.
export const CLAUDE_EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const CLAUDE_AI_DB = join('IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');
const EXTENSION_DIRS = [join('Local Extension Settings', CLAUDE_EXTENSION_ID), join('IndexedDB', `chrome-extension_${CLAUDE_EXTENSION_ID}_0.indexeddb.leveldb`)];
const PROFILE_RE = /^(Default|Profile \d+)$/;

/** Claude Desktop's and Chromium browsers' data folders, per platform. */
function appDirs(home, platform) {
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    return {
      desktop: join(support, 'Claude'),
      browsers: ['Google/Chrome', 'Google/Chrome Beta', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge', 'Arc/User Data', 'Vivaldi'].map((d) => join(support, d)),
    };
  }
  const config = join(home, '.config');
  return { desktop: join(config, 'Claude'), browsers: ['google-chrome', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge', 'vivaldi'].map((d) => join(config, d)) };
}

/** Newest modification time of the files directly in `dir` (LevelDB folders are flat), or 0. */
async function newestWrite(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const times = await Promise.all(names.map((name) => stat(join(dir, name)).then((s) => s.mtimeMs, () => 0)));
  return Math.max(0, ...times);
}

async function profiles(browserDir) {
  try {
    return (await readdir(browserDir)).filter((name) => PROFILE_RE.test(name)).map((name) => join(browserDir, name));
  } catch {
    return [];
  }
}

const iso = (ms) => (ms > 0 ? new Date(ms).toISOString() : null);
const newestOf = async (dirs) => Math.max(0, ...(await Promise.all(dirs.map(newestWrite))));

/** @returns {Promise<{ desktop: string|null, web: string|null, extension: string|null }>} ISO times of last use */
export async function surfaceActivity({ home = homedir(), platform = process.platform } = {}) {
  const { desktop, browsers } = appDirs(home, platform);
  const allProfiles = (await Promise.all(browsers.map(profiles))).flat();
  const [desktopMs, webMs, extensionMs] = await Promise.all([
    newestWrite(join(desktop, CLAUDE_AI_DB)),
    newestOf(allProfiles.map((p) => join(p, CLAUDE_AI_DB))),
    newestOf(allProfiles.flatMap((p) => EXTENSION_DIRS.map((d) => join(p, d)))),
  ]);
  return { desktop: iso(desktopMs), web: iso(webMs), extension: iso(extensionMs) };
}
