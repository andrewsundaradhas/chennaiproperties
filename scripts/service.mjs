// Runs the whole app (API + chat + admin + Telegram bot) as a macOS background service via launchd:
// starts at login, restarts automatically if it ever exits, and logs to ~/Library/Logs.
//   npm run service:install     build + install + start
//   npm run service:status      is it running? health + recent bot events
//   npm run service:logs        follow the log
//   npm run service:restart     restart (e.g. after changing .env or pulling code: run install)
//   npm run service:stop        stop until next `service:start` or login
//   npm run service:uninstall   stop and remove
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.chennaiproperties.app';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const logDir = path.join(os.homedir(), 'Library/Logs/ChennaiProperties');
const logFile = path.join(logDir, 'app.log');
const domain = `gui/${process.getuid()}`;
const cmd = process.argv[2];
const noCaffeinate = process.argv.includes('--no-caffeinate');

if (process.platform !== 'darwin') {
  console.error('This service helper is for macOS (launchd). On Linux use systemd; or deploy to Vercel (README).');
  process.exit(1);
}

const run = (file, args, opts = {}) => spawnSync(file, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
const launchctl = (...args) => run('/bin/launchctl', args);
const loaded = () => launchctl('print', `${domain}/${LABEL}`).status === 0;
const port = () => {
  const m = fs.existsSync(path.join(repo, '.env')) && fs.readFileSync(path.join(repo, '.env'), 'utf8').match(/^PORT=(\d+)/m);
  return m ? m[1] : '4000';
};

function nodeBinary() {
  // Prefer the stable Homebrew symlink so Node upgrades don't break the service.
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) if (fs.existsSync(p)) return p;
  return process.execPath;
}

function plist() {
  const node = nodeBinary();
  const args = [
    ...(noCaffeinate ? [] : ['/usr/bin/caffeinate', '-i']), // keep the Mac from idle-sleeping while serving
    node,
    `--env-file=${path.join(repo, '.env')}`,
    path.join(repo, 'server/dist/index.js'),
  ];
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${esc(path.join(repo, 'server'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict>
</plist>
`;
}

async function health() {
  try {
    const res = await fetch(`http://localhost:${port()}/api/health`, { signal: AbortSignal.timeout(3000) });
    return `${res.status} ${await res.text()}`;
  } catch {
    return 'not responding';
  }
}

function recentBotEvents(n = 5) {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((l) => /"event":"(telegram\.|server\.started)/.test(l))
    .slice(-n)
    .map((l) => l.replace(/^.*?"ts":"([^"]+)".*?"event":"([^"]+)"(.*)}$/, '$1  $2$3').slice(0, 180));
}

switch (cmd) {
  case 'install': {
    if (!fs.existsSync(path.join(repo, '.env'))) throw new Error('.env not found — create it first (cp .env.example .env).');
    const devRunning = run('/usr/bin/pgrep', ['-f', 'tsx watch']).status === 0;
    if (devRunning) console.log('⚠ `npm run dev` appears to be running. Stop it (Ctrl+C) — it uses the same port and bot.');
    console.log('Building…');
    execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit' });
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    if (loaded()) launchctl('bootout', `${domain}/${LABEL}`);
    fs.writeFileSync(plistPath, plist());
    const r = launchctl('bootstrap', domain, plistPath);
    if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr || r.stdout}`);
    console.log(`✔ Installed and started (${LABEL}).`);
    console.log(`  App:  http://localhost:${port()}   (chat)   http://localhost:${port()}/admin   (dashboard)`);
    console.log(`  Logs: ${logFile}`);
    console.log('  It starts at login and restarts automatically if it stops. Check with: npm run service:status');
    break;
  }
  case 'uninstall':
    if (loaded()) launchctl('bootout', `${domain}/${LABEL}`);
    fs.rmSync(plistPath, { force: true });
    console.log('✔ Service stopped and removed. (Logs kept in ' + logDir + ')');
    break;
  case 'stop':
    if (loaded()) launchctl('bootout', `${domain}/${LABEL}`);
    console.log('✔ Stopped. It will start again at next login, or now with: npm run service:start');
    break;
  case 'start':
    if (!fs.existsSync(plistPath)) throw new Error('Not installed. Run: npm run service:install');
    if (!loaded()) launchctl('bootstrap', domain, plistPath);
    console.log('✔ Started.');
    break;
  case 'restart':
    if (!loaded()) throw new Error('Not running. Run: npm run service:start');
    launchctl('kickstart', '-k', `${domain}/${LABEL}`);
    console.log('✔ Restarted.');
    break;
  case 'status': {
    const info = launchctl('print', `${domain}/${LABEL}`);
    if (info.status !== 0) {
      console.log(fs.existsSync(plistPath) ? 'Installed but not running. Start: npm run service:start' : 'Not installed. Install: npm run service:install');
      break;
    }
    const field = (k) => info.stdout.match(new RegExp(`\\n\\s*${k} = ([^\\n]+)`))?.[1] ?? '?';
    console.log(`Service:  ${field('state')}  (pid ${field('pid')}, runs ${field('runs')}, last exit ${field('last exit code')})`);
    console.log(`Health:   ${await health()}`);
    console.log('Recent bot events:');
    for (const e of recentBotEvents()) console.log('  ' + e);
    break;
  }
  case 'logs':
    spawnSync('/usr/bin/tail', ['-n', '50', '-F', logFile], { stdio: 'inherit' });
    break;
  default:
    console.log('Usage: npm run service:<install|status|logs|restart|stop|start|uninstall>');
}
