// Background reporting: Claude Code's hooks only report while Claude Code runs, so plan % used from Claude
// Desktop, claude.ai or the Chrome extension went unseen until the next Claude Code session. On macOS a
// LaunchAgent runs a throttled `push` every 5 minutes instead; elsewhere `cronLine` gives the crontab entry.
// It still needs the Claude login Claude Code keeps fresh (about 8 hours after Claude Code last ran).
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_PATH } from './config.js';

const LABEL = 'com.claude-usage-tracker.push';
const INTERVAL_SEC = 300;
// A little under the interval, so a run is never skipped because the previous one was a few seconds late.
const THROTTLE_SEC = 240;
const SYSTEM_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const LOG_PATH = join(dirname(CONFIG_PATH), 'background.log');

const execFileAsync = promisify(execFile);
const launchctl = (args) => execFileAsync('launchctl', args);
const plistPath = (dir) => join(dir, `${LABEL}.plist`);

const escapeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeXml = (value) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const entry = (key, value) => `    <key>${key}</key>\n    <string>${escapeXml(value)}</string>`;

/** The LaunchAgent: `node cli.js push --throttle 240` every 5 minutes and at login. */
export function launchAgentPlist({ node, cli, pluginData, logPath = LOG_PATH }) {
  // launchd starts jobs with a bare PATH: ccusage lives next to node (npm global) or in Homebrew.
  const env = [entry('PATH', `${dirname(node)}:${SYSTEM_PATH}`), ...(pluginData ? [entry('CLAUDE_PLUGIN_DATA', pluginData)] : [])];
  const args = [node, cli, 'push', '--throttle', String(THROTTLE_SEC)].map((a) => `    <string>${escapeXml(a)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env.join('\n')}
  </dict>
  <key>StartInterval</key>
  <integer>${INTERVAL_SEC}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

/** The same schedule as a crontab line, for Linux and other systems without launchd. */
export const cronLine = ({ node, cli }) => `*/5 * * * * "${node}" "${cli}" push --throttle ${THROTTLE_SEC}`;

async function readPlist(dir) {
  try {
    return await readFile(plistPath(dir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Writes the LaunchAgent and (re)loads it. */
export async function enableBackground({ node, cli, pluginData, logPath, dir = LAUNCH_AGENTS_DIR, run = launchctl, uid = process.getuid() }) {
  const path = plistPath(dir);
  await mkdir(dir, { recursive: true });
  await mkdir(dirname(logPath ?? LOG_PATH), { recursive: true });
  await writeFile(path, launchAgentPlist({ node, cli, pluginData, logPath }));
  await run(['bootout', `gui/${uid}/${LABEL}`]).catch(() => {}); // not loaded yet
  await run(['bootstrap', `gui/${uid}`, path]);
  return { path };
}

/** @returns {Promise<boolean>} whether it was installed */
export async function disableBackground({ dir = LAUNCH_AGENTS_DIR, run = launchctl, uid = process.getuid() } = {}) {
  if ((await readPlist(dir)) === null) return false;
  await run(['bootout', `gui/${uid}/${LABEL}`]).catch(() => {});
  await rm(plistPath(dir), { force: true });
  return true;
}

/** @returns {Promise<{ installed: boolean, node?: string, cli?: string }>} */
export async function backgroundStatus({ dir = LAUNCH_AGENTS_DIR } = {}) {
  const xml = await readPlist(dir);
  if (xml === null) return { installed: false };
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? '';
  const [node, cli] = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unescapeXml(m[1]));
  return { installed: true, cli, node };
}

/**
 * Called from Claude Code's hooks: once turned on, keeps the LaunchAgent pointing at the current plugin and
 * node (both paths change on updates). Never turns it on by itself.
 * @returns {Promise<boolean>} whether it was rewritten
 */
export async function refreshBackground({ node, cli, pluginData, logPath, dir = LAUNCH_AGENTS_DIR, run = launchctl, uid = process.getuid() }) {
  const current = await readPlist(dir);
  if (current === null || current === launchAgentPlist({ node, cli, pluginData, logPath })) return false;
  await enableBackground({ node, cli, pluginData, logPath, dir, run, uid });
  return true;
}
