#!/usr/bin/env node
'use strict';

const { execSync, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CONFIG_DIR = path.join(os.homedir(), '.dispatch');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const REPO_ROOT = path.resolve(__dirname, '..');

// ── colour helpers (no deps) ─────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  green: '\x1b[32m',
  red:   '\x1b[31m',
  yellow:'\x1b[33m',
  cyan:  '\x1b[36m',
  gray:  '\x1b[90m',
};
const bold   = s => `${c.bold}${s}${c.reset}`;
const green  = s => `${c.green}${s}${c.reset}`;
const red    = s => `${c.red}${s}${c.reset}`;
const yellow = s => `${c.yellow}${s}${c.reset}`;
const cyan   = s => `${c.cyan}${s}${c.reset}`;
const gray   = s => `${c.gray}${s}${c.reset}`;

// ── prompt helpers ───────────────────────────────────────────────────────────
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function promptSecret(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    let value = '';
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = ch => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(value);
      } else if (ch === '') {
        process.exit();
      } else if (ch === '') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

// ── config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ── Salesforce auth ──────────────────────────────────────────────────────────
async function sfRequest(instanceUrl, accessToken, path, method = 'GET', body) {
  const url = new URL(path, instanceUrl);
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url.toString(), opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`Salesforce API error ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdConnect() {
  console.log(bold('\n  Salesforce Connection Setup\n'));

  const defaultInstance = 'https://loving.my.salesforce.com';
  const instanceRaw = await prompt(`  Instance URL ${gray('[' + defaultInstance + ']')}: `);
  const instanceUrl = instanceRaw || defaultInstance;
  const cleanInstance = instanceUrl.startsWith('http') ? instanceUrl : `https://${instanceUrl}`;

  // Try sf CLI first — it's already installed if Codex/Salesforce CLI works
  try {
    execSync('sf --version', { stdio: 'ignore' });
    console.log(gray('  Salesforce CLI detected — opening browser to log in…\n'));
    execSync(`sf org login web --instance-url ${cleanInstance} --alias dispatch`, { stdio: 'inherit' });
    const raw = execSync('sf org display --target-org dispatch --json', { encoding: 'utf8' });
    const info = JSON.parse(raw).result;
    const cfg = loadConfig();
    cfg.salesforce = {
      instanceUrl: info.instanceUrl,
      accessToken: info.accessToken,
      username: info.username,
      connectedAt: new Date().toISOString(),
    };
    saveConfig(cfg);
    console.log(green(`\n  Connected as ${bold(info.username)}`));
    console.log(gray(`  Instance : ${info.instanceUrl}`));
    console.log(gray(`  Config   : ${CONFIG_FILE}\n`));
    return;
  } catch {
    // sf CLI not available — fall through to browser OAuth flow
  }

  // Browser OAuth flow — opens Salesforce login in browser, catches token on localhost
  const CALLBACK_PORT = 1717;
  const CLIENT_ID = 'PlatformCLI';
  const redirectUri = `http://localhost:${CALLBACK_PORT}/callback`;
  const authUrl = `${cleanInstance}/services/oauth2/authorize?response_type=token&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  console.log(gray('  Opening Salesforce login in your browser…'));
  console.log(gray(`  If it does not open, visit:\n  ${authUrl}\n`));

  const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { execSync(`${open} "${authUrl}"`); } catch {}

  const tokenData = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const html = `<html><body style="font-family:sans-serif;padding:2em">
        <h2>Dispatch CLI</h2>
        <p id="msg">Completing login…</p>
        <script>
          const hash = location.hash.slice(1);
          if(hash){
            fetch('/token?' + hash).then(()=>{ document.getElementById('msg').textContent='Connected! You can close this tab.'; });
          } else {
            document.getElementById('msg').textContent='No token received. Please try again.';
          }
        </script></body></html>`;

      if (req.url.startsWith('/token?')) {
        const params = new URLSearchParams(req.url.slice(7));
        const accessToken = params.get('access_token');
        const instanceUrlRaw = params.get('instance_url');
        res.writeHead(200); res.end('ok');
        server.close();
        if (accessToken) resolve({ access_token: accessToken, instance_url: decodeURIComponent(instanceUrlRaw || cleanInstance) });
        else reject(new Error('No access token in callback'));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(gray(`  Waiting for login… (listening on port ${CALLBACK_PORT})`));
    });

    setTimeout(() => { server.close(); reject(new Error('Login timed out after 3 minutes')); }, 180000);
  });

  const cfg = loadConfig();
  cfg.salesforce = {
    instanceUrl: tokenData.instance_url,
    accessToken: tokenData.access_token,
    username: null,
    connectedAt: new Date().toISOString(),
  };

  // Fetch username
  try {
    const info = await sfRequest(tokenData.instance_url, tokenData.access_token, '/services/oauth2/userinfo');
    cfg.salesforce.username = info.preferred_username || info.email;
  } catch {}

  saveConfig(cfg);
  console.log(green(`\n  Connected${cfg.salesforce.username ? ' as ' + bold(cfg.salesforce.username) : ''}`));
  console.log(gray(`  Instance : ${cfg.salesforce.instanceUrl}`));
  console.log(gray(`  Config   : ${CONFIG_FILE}\n`));
}

async function cmdStatus() {
  console.log(bold('\n  Dispatch Status\n'));

  // Git status
  try {
    const branch = execSync('git branch --show-current', { cwd: REPO_ROOT }).toString().trim();
    const gitLog = execSync('git log -1 --pretty="%h %s (%ar)"', { cwd: REPO_ROOT }).toString().trim();
    const dirty  = execSync('git status --porcelain', { cwd: REPO_ROOT }).toString().trim();
    console.log(`  ${cyan('Git')}    branch : ${bold(branch)}`);
    console.log(`         latest : ${gray(gitLog)}`);
    console.log(`         state  : ${dirty ? yellow('uncommitted changes') : green('clean')}`);
  } catch {
    console.log(`  ${cyan('Git')}    ${red('not a git repository')}`);
  }

  // Salesforce status
  const cfg = loadConfig();
  const sf = cfg.salesforce;
  if (sf) {
    console.log(`\n  ${cyan('Salesforce')}`);
    console.log(`         user     : ${bold(sf.username)}`);
    console.log(`         instance : ${sf.instanceUrl}`);
    console.log(`         connected: ${gray(new Date(sf.connectedAt).toLocaleString())}`);

    // Quick token check
    try {
      await sfRequest(sf.instanceUrl, sf.accessToken, '/services/oauth2/userinfo');
      console.log(`         token    : ${green('valid')}`);
    } catch {
      console.log(`         token    : ${red('expired — run: dispatch connect')}`);
    }
  } else {
    console.log(`\n  ${cyan('Salesforce')} not connected — run: ${bold('dispatch connect')}`);
  }

  console.log();
}

async function cmdDeploy(args) {
  const msgFlag = args.indexOf('--message');
  const mFlag   = args.indexOf('-m');
  let message   = '';
  if (msgFlag !== -1) message = args[msgFlag + 1] || '';
  else if (mFlag !== -1) message = args[mFlag + 1] || '';

  if (!message) {
    message = await prompt('  Commit message: ');
  }
  if (!message) message = 'Update dispatch site';

  console.log(gray('\n  Staging files…'));
  const siteFiles = ['index.html', 'dispatch.html', 'working.html', 'app.js', 'dispatch-data.xlsx', '.nojekyll'];
  const existing = siteFiles.filter(f => fs.existsSync(path.join(REPO_ROOT, f)));
  execSync(`git add ${existing.join(' ')}`, { cwd: REPO_ROOT, stdio: 'inherit' });

  const dirty = execSync('git diff --cached --name-only', { cwd: REPO_ROOT }).toString().trim();
  if (!dirty) {
    console.log(yellow('  Nothing to deploy — working tree is clean.\n'));
    return;
  }

  console.log(gray('  Committing…'));
  execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: REPO_ROOT, stdio: 'inherit' });

  console.log(gray('  Pushing to main…'));
  execSync('git push origin main', { cwd: REPO_ROOT, stdio: 'inherit' });

  console.log(green('\n  Deployed! GitHub Actions will publish the site in ~1 minute.\n'));
}

async function cmdPreview(args) {
  const portFlag = args.indexOf('--port');
  const port = portFlag !== -1 ? parseInt(args[portFlag + 1], 10) || 3000 : 3000;

  const mimeTypes = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon',
  };

  const server = http.createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(REPO_ROOT, urlPath);

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });

  server.listen(port, () => {
    console.log(bold(`\n  Preview server running\n`));
    console.log(`  ${cyan('Open')}  http://localhost:${port}`);
    console.log(gray('  Press Ctrl+C to stop.\n'));
  });

  process.on('SIGINT', () => { server.close(); process.exit(0); });
}

async function cmdSync() {
  const cfg = loadConfig();
  const sf = cfg.salesforce;
  if (!sf) {
    console.log(red('\n  Not connected. Run: dispatch connect\n'));
    process.exit(1);
  }

  console.log(gray('\n  Querying Salesforce for dispatch jobs…'));
  // Placeholder SOQL — adjust object/field names to match your org schema
  const soql = encodeURIComponent(
    "SELECT Id, Name, Community__c, Address__c, Task_Type__c, Field_Manager__c FROM Dispatch_Job__c ORDER BY Field_Manager__c, Stop_Number__c LIMIT 2000"
  );

  try {
    const result = await sfRequest(sf.instanceUrl, sf.accessToken, `/services/data/v60.0/query?q=${soql}`);
    const count = result.totalSize || 0;
    console.log(green(`  Retrieved ${count} record(s).`));
    console.log(gray('  (Wire up your SOQL and field mapping in bin/dispatch.js → cmdSync)\n'));
  } catch (err) {
    console.log(red(`  Query failed: ${err.message}`));
    console.log(gray('  Ensure your SOQL object/field names match your org schema.\n'));
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
  ${bold('dispatch')} — LOVING Dispatch site CLI

  ${bold('Usage:')}
    dispatch <command> [options]

  ${bold('Commands:')}
    ${cyan('connect')}              Authenticate to Salesforce
    ${cyan('status')}               Show git and Salesforce connection status
    ${cyan('deploy')} [-m "msg"]    Commit and push site to GitHub Pages
    ${cyan('preview')} [--port N]   Serve the site locally (default port 3000)
    ${cyan('sync')}                 Pull job data from Salesforce (configure SOQL first)
    ${cyan('help')}                 Show this help

  ${bold('Examples:')}
    dispatch connect
    dispatch deploy -m "Update zone assignments"
    dispatch preview --port 8080
    dispatch status
`);
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case 'connect': await cmdConnect(); break;
    case 'status':  await cmdStatus();  break;
    case 'deploy':  await cmdDeploy(args); break;
    case 'preview': await cmdPreview(args); break;
    case 'sync':    await cmdSync(); break;
    case 'help':
    case '--help':
    case '-h':
    case undefined: printHelp(); break;
    default:
      console.log(red(`\n  Unknown command: ${cmd}\n`));
      printHelp();
      process.exit(1);
  }
})();
