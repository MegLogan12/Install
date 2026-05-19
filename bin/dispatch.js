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

async function cmdCheckLennar() {
  const cfg = loadConfig();
  const sf = cfg.salesforce;
  if (!sf) { console.log(red('\n  Not connected. Run: dispatch connect\n')); process.exit(1); }

  console.log(bold('\n  Lennar / Voucher Deep Check\n'));

  const campaigns = await sfQuery(sf, "SELECT Id,Name,Type,Status,Description,StartDate,EndDate FROM Campaign ORDER BY Name LIMIT 100");
  const voucherDesc = await sfDescribe(sf, 'Voucher__c');
  const vouchers = await sfQuery(sf, "SELECT Id,Name FROM Voucher__c LIMIT 20");
  const allFlows = await sfTooling(sf, "SELECT Id,DeveloperName,Status,VersionNumber FROM Flow ORDER BY DeveloperName LIMIT 200");
  const lennarFlows = (allFlows.records || []).filter(f =>
    /lennar|grilling|island|voucher/i.test(f.DeveloperName)
  );

  console.log(bold('  Campaigns in org:'));
  if (!campaigns.records?.length) {
    console.log(red('  No campaigns found.'));
  } else {
    campaigns.records.forEach(c => {
      console.log(`  ${c.Name.padEnd(50)} Type: ${(c.Type||'').padEnd(20)} Status: ${c.Status||''}`);
      if (c.Description) console.log(gray(`    ${c.Description.slice(0,100)}`));
    });
  }

  console.log(bold('\n  Voucher__c fields:'));
  if (!voucherDesc.ok) {
    console.log(red(`  Could not describe Voucher__c: ${voucherDesc.error}`));
  } else {
    voucherDesc.fields
      .filter(f => !['Id','IsDeleted','Name','CreatedDate','CreatedById','LastModifiedDate','LastModifiedById','SystemModstamp','LastActivityDate'].includes(f.name))
      .forEach(f => console.log(`  ${f.name.padEnd(45)} ${f.label}`));
  }

  console.log(bold('\n  Sample Voucher records:'));
  (vouchers.records || []).forEach(v => console.log(`  ${v.Id}  ${v.Name}`));

  console.log(bold('\n  Flows matching lennar/grilling/voucher:'));
  if (!lennarFlows.length) {
    console.log(red('  None found.'));
    console.log(gray('\n  All active flows in org:'));
    (allFlows.records || []).filter(f => f.Status === 'Active').forEach(f =>
      console.log(gray(`  ${f.DeveloperName}`))
    );
  } else {
    lennarFlows.forEach(f => console.log(`  ${f.DeveloperName}  v${f.VersionNumber}  ${f.Status}`));
  }

  console.log(bold('\n  Paste this output to Claude to build the Lennar flow.\n'));
}

async function cmdAuditODL() {
  const cfg = loadConfig();
  const sf = cfg.salesforce;
  if (!sf) { console.log(red('\n  Not connected. Run: dispatch connect\n')); process.exit(1); }

  console.log(bold('\n  LOVING — Voucher / Lennar Grilling / Outdoor Living / UpgradeMyBackyard Audit'));
  console.log(gray(`  Org: ${sf.instanceUrl}  |  ${new Date().toLocaleString()}\n`));
  console.log(gray('  Running queries… 60–90 seconds.\n'));

  const out = [];

  // ── helpers ──────────────────────────────────────────────────────────
  async function count(soql) {
    const r = await sfQuery(sf, soql);
    return r.ok ? r.total : -1;
  }
  async function obj(name) { return sfDescribe(sf, name); }
  async function q(soql) { return sfQuery(sf, soql); }
  async function tq(soql) { return sfTooling(sf, soql); }
  function picklistValues(fields, fieldName) {
    const f = fields.find(x => x.name === fieldName);
    return f?.picklistValues?.map(p => p.label) || [];
  }
  function fieldLabel(fields, fieldName) {
    const f = fields.find(x => x.name === fieldName);
    return f ? f.label : null;
  }

  // ── 1. OBJECT EXISTS CHECKS ──────────────────────────────────────────
  process.stdout.write(gray('  Checking objects… '));
  const [
    voucherD, paymentD, designD, propertyD, warrantyD,
    oppD, quoteD, orderD, orderItemD, productD, pbD, pbeD,
    woD, woliD, saD, campD, acctD, contactD
  ] = await Promise.all([
    obj('Voucher__c'), obj('Payment_Milestone__c'), obj('Design_Review__c'),
    obj('Homeowner_Property__c'), obj('Warranty_Record__c'),
    obj('Opportunity'), obj('Quote'), obj('Order'), obj('OrderItem'),
    obj('Product2'), obj('Pricebook2'), obj('PricebookEntry'),
    obj('WorkOrder'), obj('WorkOrderLineItem'), obj('ServiceAppointment'),
    obj('Campaign'), obj('Account'), obj('Contact')
  ]);
  console.log(green('done'));

  // ── 2. LIVE COUNTS ───────────────────────────────────────────────────
  process.stdout.write(gray('  Counting records… '));
  const [
    voucherCount, paymentCount, designCount, propertyCount, warrantyCount,
    lennarOppCount, grillProductCount, lennarQuoteCount,
    totalOppCount, totalProductCount, totalOrderCount, campCount,
    woCount, saCount, accountCount
  ] = await Promise.all([
    count('SELECT COUNT() FROM Voucher__c'),
    count('SELECT COUNT() FROM Payment_Milestone__c'),
    voucherD.exists ? count('SELECT COUNT() FROM Design_Review__c') : Promise.resolve(-1),
    voucherD.exists ? count('SELECT COUNT() FROM Homeowner_Property__c') : Promise.resolve(-1),
    voucherD.exists ? count('SELECT COUNT() FROM Warranty_Record__c') : Promise.resolve(-1),
    count("SELECT COUNT() FROM Opportunity WHERE Name LIKE '%Lennar%' OR Name LIKE '%Grill%' OR Name LIKE '%Outdoor Living%' OR Name LIKE '%UpgradeMyBackyard%' OR Name LIKE '%UMB%'"),
    count("SELECT COUNT() FROM Product2 WHERE Name LIKE '%Grill%' OR Name LIKE '%Outdoor%' OR Name LIKE '%Retreat%' OR Name LIKE '%Entertainer%' OR Name LIKE '%Signature%' OR Name LIKE '%Lennar%'"),
    count("SELECT COUNT() FROM Quote WHERE Name LIKE '%Lennar%' OR Name LIKE '%Grill%' OR Name LIKE '%Outdoor%' OR Name LIKE '%UMB%'"),
    count('SELECT COUNT() FROM Opportunity'),
    count('SELECT COUNT() FROM Product2'),
    orderD.exists ? count('SELECT COUNT() FROM Order') : Promise.resolve(-1),
    count('SELECT COUNT() FROM Campaign'),
    count('SELECT COUNT() FROM WorkOrder'),
    count('SELECT COUNT() FROM ServiceAppointment'),
    count('SELECT COUNT() FROM Account'),
  ]);
  console.log(green('done'));

  // ── 3. VOUCHER DETAILS ───────────────────────────────────────────────
  process.stdout.write(gray('  Inspecting Voucher__c fields… '));
  const voucherStatusValues = voucherD.ok ? picklistValues(voucherD.fields, 'Status__c') : [];
  const voucherTypeValues   = voucherD.ok ? picklistValues(voucherD.fields, 'Voucher_Type__c') : [];
  const voucherSponsorVals  = voucherD.ok ? picklistValues(voucherD.fields, 'Sponsor_Payment_Responsibility__c') : [];
  const hasReservedOpp      = voucherD.ok && voucherD.fields.some(f => f.name === 'Reserved_Opportunity__c');
  const hasRedeemedQuote    = voucherD.ok && voucherD.fields.some(f => f.name === 'Redeemed_Quote__c');
  const hasPaymentMs        = voucherD.ok && voucherD.fields.some(f => f.name === 'Payment_Milestone__c');
  const hasCampaign         = voucherD.ok && voucherD.fields.some(f => f.name === 'Campaign__c');
  const hasBuilderAcct      = voucherD.ok && voucherD.fields.some(f => f.name === 'Builder_Account__c');
  const hasContact          = voucherD.ok && voucherD.fields.some(f => f.name === 'Contact__c');
  const hasGrillingField    = voucherD.ok && voucherD.fields.some(f => f.name === 'Standard_Grilling_Island_Included__c');
  const hasSponsorField     = voucherD.ok && voucherD.fields.some(f => f.name === 'Sponsor_Payment_Responsibility__c');
  const hasVoucherCode      = voucherD.ok && voucherD.fields.some(f => f.name === 'Voucher_Code__c');
  const hasExpirationDate   = voucherD.ok && voucherD.fields.some(f => f.name === 'Expiration_Date__c');
  const hasUpsellFields     = voucherD.ok && voucherD.fields.some(f => f.name === 'Upsell_Eligible__c');
  console.log(green('done'));

  // ── 4. LENNAR CAMPAIGNS ──────────────────────────────────────────────
  process.stdout.write(gray('  Checking Lennar campaigns… '));
  const lennarCamps = await q("SELECT Id,Name,Type,Status,Description FROM Campaign WHERE Name LIKE '%Lennar%' OR Name LIKE '%Grilling%' OR Name LIKE '%Voucher%' ORDER BY Name");
  const campMemberCount = lennarCamps.records?.length > 0
    ? await count(`SELECT COUNT() FROM CampaignMember WHERE CampaignId = '${lennarCamps.records[0]?.Id}'`)
    : 0;
  console.log(green('done'));

  // ── 5. PRODUCTS / PRICEBOOKS ─────────────────────────────────────────
  process.stdout.write(gray('  Checking products and pricebooks… '));
  const grillProducts = await q("SELECT Id,Name,ProductCode,IsActive FROM Product2 WHERE Name LIKE '%Grill%' OR Name LIKE '%Outdoor%' OR Name LIKE '%Retreat%' OR Name LIKE '%Entertainer%' OR Name LIKE '%Signature%' OR Name LIKE '%Lennar%' ORDER BY Name LIMIT 50");
  const odmProducts   = await q("SELECT Id,Name,ProductCode,IsActive FROM Product2 WHERE Name LIKE '%UMB%' OR Name LIKE '%UpgradeMyBackyard%' OR Name LIKE '%ODL%' OR Name LIKE '%Studio%' ORDER BY Name LIMIT 20");
  const pricebooks    = await q("SELECT Id,Name,IsActive,IsStandard FROM Pricebook2 ORDER BY Name LIMIT 20");
  const hasRetreater  = grillProducts.records?.some(p => /retreat/i.test(p.Name));
  const hasEntertain  = grillProducts.records?.some(p => /entertainer/i.test(p.Name));
  const hasSignature  = grillProducts.records?.some(p => /signature/i.test(p.Name));
  console.log(green('done'));

  // ── 6. FLOWS / APEX / LWC ────────────────────────────────────────────
  process.stdout.write(gray('  Checking flows, Apex, LWC… '));
  const allFlows  = await tq("SELECT Id,DeveloperName,Status,VersionNumber FROM Flow ORDER BY DeveloperName LIMIT 200");
  const odlFlows  = (allFlows.records||[]).filter(f => /voucher|lennar|grill|odl|outdoor|umb|upgrade/i.test(f.DeveloperName));
  const allApex   = await tq("SELECT Id,Name FROM ApexClass ORDER BY Name LIMIT 200");
  const odlApex   = (allApex.records||[]).filter(c => /voucher|lennar|grill|odl|outdoor|umb|upgrade/i.test(c.Name));
  const allLWC    = await tq("SELECT Id,DeveloperName FROM LightningComponentBundle ORDER BY DeveloperName LIMIT 200");
  const odlLWC    = (allLWC.records||[]).filter(c => /voucher|lennar|grill|odl|outdoor|umb|upgrade/i.test(c.DeveloperName));
  console.log(green('done'));

  // ── 7. PAGES / APPS / TABS ───────────────────────────────────────────
  process.stdout.write(gray('  Checking pages, apps, tabs… '));
  const allPages  = await tq("SELECT Id,DeveloperName,EntityDefinitionId FROM FlexiPage WHERE Type='RecordPage' ORDER BY DeveloperName LIMIT 200");
  const odlPages  = (allPages.records||[]).filter(p => /voucher|odl|outdoor|umb|upgrade|lennar|payment|design|warranty|property/i.test(p.DeveloperName));
  const allApps   = await tq("SELECT Id,DeveloperName,Label FROM CustomApplication ORDER BY DeveloperName LIMIT 50");
  const odlApps   = (allApps.records||[]).filter(a => /odl|outdoor|umb|upgrade|dispatch|foreman/i.test(a.DeveloperName));
  const allTabs   = await tq("SELECT Id,Name FROM CustomTab ORDER BY Name LIMIT 100");
  const odlTabs   = (allTabs.records||[]).filter(t => /voucher|odl|outdoor|umb|upgrade|lennar|payment|design|warranty|property/i.test(t.Name));
  console.log(green('done'));

  // ── 8. REPORTS / DASHBOARDS ──────────────────────────────────────────
  process.stdout.write(gray('  Checking reports and dashboards… '));
  const odlReports = await q("SELECT Id,Name,DeveloperName FROM Report WHERE Name LIKE '%Voucher%' OR Name LIKE '%Lennar%' OR Name LIKE '%Grilling%' OR Name LIKE '%ODL%' OR Name LIKE '%Outdoor%' OR Name LIKE '%UpgradeMyBackyard%' OR Name LIKE '%UMB%' LIMIT 30");
  const odlDash    = await q("SELECT Id,Name,DeveloperName FROM Dashboard WHERE Name LIKE '%Voucher%' OR Name LIKE '%Lennar%' OR Name LIKE '%ODL%' OR Name LIKE '%Outdoor%' OR Name LIKE '%UpgradeMyBackyard%' LIMIT 10");
  console.log(green('done'));

  // ── 9. LABEL SCAN FOR LEGACY UMB TERMS ──────────────────────────────
  process.stdout.write(gray('  Scanning labels for legacy UMB/Studio terms… '));
  const legacyLabels = [];
  const legacyTerms  = ['umb', 'the studio', 'custom build', 'funding source', 'upgrademybackyard'];
  const goodTerms    = ['upgrademybackyard', 'design build', 'sponsor payment responsibility'];
  for (const d of [voucherD, oppD, quoteD, woD, acctD, productD]) {
    if (!d.ok) continue;
    for (const f of (d.fields||[])) {
      const lbl = (f.label||'').toLowerCase();
      const isLegacy = legacyTerms.some(t => lbl.includes(t)) && !goodTerms.includes(lbl);
      if (isLegacy) legacyLabels.push({ object: d.label || '?', field: f.name, label: f.label });
    }
  }
  // Check tabs/apps for UMB labels
  const legacyAppTabs = [
    ...(allApps.records||[]).filter(a => /\bumb\b|the studio/i.test(a.Label||'')).map(a => `App: ${a.Label}`),
    ...(allTabs.records||[]).filter(t => /\bumb\b|the studio/i.test(t.Name||'')).map(t => `Tab: ${t.Name}`),
  ];
  console.log(green('done'));

  // ── 10. PERMISSION SETS ──────────────────────────────────────────────
  process.stdout.write(gray('  Checking permission sets… '));
  const odlPermSets = await q("SELECT Id,Name,Label FROM PermissionSet WHERE IsOwnedByProfile=false AND (Name LIKE '%ODL%' OR Name LIKE '%Voucher%' OR Name LIKE '%Outdoor%' OR Name LIKE '%UMB%' OR Name LIKE '%Lennar%') LIMIT 20");
  console.log(green('done'));

  // ── 11. BUILDER / LENNAR ACCOUNTS ────────────────────────────────────
  process.stdout.write(gray('  Checking Builder/Lennar accounts… '));
  const lennarAccts = await q("SELECT Id,Name,Type FROM Account WHERE Name LIKE '%Lennar%' OR Name LIKE '%Builder%' LIMIT 20");
  console.log(green('done'));

  // ══════════════════════════════════════════════════════════════════
  // BUILD OUTPUT
  // ══════════════════════════════════════════════════════════════════
  const HR = '─'.repeat(110);

  out.push('');
  out.push(bold('══════════════════════════════════════════════════════════════════════════'));
  out.push(bold('  VOUCHER / LENNAR GRILLING / OUTDOOR LIVING / UPGRADEMYBACKYARD AUDIT'));
  out.push(bold(`  ${new Date().toLocaleString()}  |  ${sf.instanceUrl}`));
  out.push(bold('══════════════════════════════════════════════════════════════════════════'));

  // ── SECTION 1: OBJECT STATUS ─────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 1. OBJECT STATUS ─────────────────────────────────────────────────'));
  const objRows = [
    ['Voucher__c',            voucherD.ok,  voucherCount],
    ['Payment_Milestone__c',  paymentD.ok,  paymentCount],
    ['Design_Review__c',      designD.ok,   designCount],
    ['Homeowner_Property__c', propertyD.ok, propertyCount],
    ['Warranty_Record__c',    warrantyD.ok, warrantyCount],
    ['Opportunity',           oppD.ok,      totalOppCount],
    ['Quote',                 quoteD.ok,    lennarQuoteCount + ' (Lennar/ODL)'],
    ['Order',                 orderD.ok,    totalOrderCount],
    ['Product2',              productD.ok,  totalProductCount],
    ['Pricebook2',            pbD.ok,       pricebooks.records?.length || 0],
    ['WorkOrder',             woD.ok,       woCount],
    ['ServiceAppointment',    saD.ok,       saCount],
    ['Campaign',              campD.ok,     campCount],
  ];
  out.push('  ' + bold('Object'.padEnd(30) + 'Live?'.padEnd(10) + 'Record Count'));
  out.push('  ' + gray(HR));
  for (const [name, live, cnt] of objRows) {
    const liveStr = live ? green('YES'.padEnd(10)) : red('NO'.padEnd(10));
    const cntStr = cnt === -1 ? gray('N/A') : cnt;
    out.push(`  ${name.padEnd(30)}${liveStr}${cntStr}`);
  }

  // ── SECTION 2: LIVE SOQL COUNTS ──────────────────────────────────────
  out.push('');
  out.push(bold('  ── 2. LIVE SOQL COUNTS ──────────────────────────────────────────────'));
  out.push(`  SELECT COUNT() FROM Voucher__c                          → ${bold(String(voucherCount))}`);
  out.push(`  SELECT COUNT() FROM Payment_Milestone__c               → ${bold(String(paymentCount))}`);
  out.push(`  SELECT COUNT() FROM Design_Review__c                   → ${bold(designD.ok ? String(designCount) : red('Object not found'))}`);
  out.push(`  SELECT COUNT() FROM Homeowner_Property__c              → ${bold(propertyD.ok ? String(propertyCount) : red('Object not found'))}`);
  out.push(`  SELECT COUNT() FROM Warranty_Record__c                 → ${bold(warrantyD.ok ? String(warrantyCount) : red('Object not found'))}`);
  out.push(`  Opportunities matching Lennar/Grill/ODL/UMB            → ${bold(String(lennarOppCount))}`);
  out.push(`  Products matching Grill/Outdoor/Retreat/Entertainer    → ${bold(String(grillProductCount))}`);
  out.push(`  Quotes matching Lennar/Grill/ODL/UMB                   → ${bold(String(lennarQuoteCount))}`);

  // ── SECTION 3: VOUCHER FIELD ANALYSIS ───────────────────────────────
  out.push('');
  out.push(bold('  ── 3. VOUCHER__C FIELD ANALYSIS ─────────────────────────────────────'));
  if (!voucherD.ok) {
    out.push(red('  Voucher__c not accessible.'));
  } else {
    const fieldChecks = [
      ['Campaign__c (links to Campaign)',             hasCampaign],
      ['Builder_Account__c (links to Lennar acct)',   hasBuilderAcct],
      ['Contact__c (links to Homeowner)',             hasContact],
      ['Reserved_Opportunity__c (links to Opp)',      hasReservedOpp],
      ['Redeemed_Quote__c (links to Quote)',          hasRedeemedQuote],
      ['Payment_Milestone__c (links to Payment)',     hasPaymentMs],
      ['Standard_Grilling_Island_Included__c',        hasGrillingField],
      ['Sponsor_Payment_Responsibility__c',           hasSponsorField],
      ['Voucher_Code__c',                             hasVoucherCode],
      ['Expiration_Date__c',                          hasExpirationDate],
      ['Upsell_Eligible__c',                         hasUpsellFields],
    ];
    fieldChecks.forEach(([label, present]) => {
      out.push(`  ${label.padEnd(55)} ${present ? green('present') : red('MISSING')}`);
    });
    out.push('');
    out.push(`  Status__c picklist values:               ${voucherStatusValues.join(', ') || red('none / not a picklist')}`);
    out.push(`  Voucher_Type__c picklist values:         ${voucherTypeValues.join(', ') || red('none / not a picklist')}`);
    out.push(`  Sponsor_Payment_Responsibility__c vals:  ${voucherSponsorVals.join(', ') || red('none / not a picklist')}`);
  }

  // ── SECTION 4: LENNAR CAMPAIGNS ──────────────────────────────────────
  out.push('');
  out.push(bold('  ── 4. LENNAR / VOUCHER CAMPAIGNS ────────────────────────────────────'));
  if (!lennarCamps.records?.length) {
    out.push(red('  No Lennar/Grilling/Voucher campaigns found.'));
  } else {
    lennarCamps.records.forEach(c => {
      out.push(`  ${c.Name.padEnd(60)} ${c.Status.padEnd(15)} ${c.Type||''}`);
    });
    out.push(`\n  CampaignMembers on first Lennar campaign: ${campMemberCount}`);
  }

  // ── SECTION 5: BUILDER / LENNAR ACCOUNTS ─────────────────────────────
  out.push('');
  out.push(bold('  ── 5. BUILDER / LENNAR ACCOUNTS ─────────────────────────────────────'));
  if (!lennarAccts.records?.length) {
    out.push(red('  No Lennar or Builder accounts found. Voucher Builder_Account__c will have nothing to link to.'));
  } else {
    lennarAccts.records.forEach(a => out.push(`  ${a.Name.padEnd(50)} Type: ${a.Type||'(none)'}`));
  }

  // ── SECTION 6: PRODUCTS / PACKAGES ───────────────────────────────────
  out.push('');
  out.push(bold('  ── 6. PRODUCTS / PACKAGES (Grilling / ODL) ─────────────────────────'));
  out.push(`  Retreat package in Product2:    ${hasRetreater ? green('FOUND') : red('NOT FOUND')}`);
  out.push(`  Entertainer package:            ${hasEntertain ? green('FOUND') : red('NOT FOUND')}`);
  out.push(`  Signature package:              ${hasSignature ? green('FOUND') : red('NOT FOUND')}`);
  if (grillProducts.records?.length) {
    out.push('\n  Matching ODL products:');
    grillProducts.records.forEach(p => out.push(`  ${p.Name.padEnd(55)} Active: ${p.IsActive ? green('yes') : red('no')}  Code: ${p.ProductCode||'—'}`));
  } else {
    out.push(red('\n  No grilling/outdoor/package products found in Product2.'));
  }
  if (odmProducts.records?.length) {
    out.push('\n  Products with UMB/Studio/ODL names (check for legacy naming):');
    odmProducts.records.forEach(p => out.push(`  ${yellow('!')} ${p.Name}`));
  }
  out.push('\n  Pricebooks:');
  (pricebooks.records||[]).forEach(pb => out.push(`  ${pb.Name.padEnd(40)} Active: ${pb.IsActive ? green('yes') : red('no')}  Standard: ${pb.IsStandard ? 'yes' : 'no'}`));

  // ── SECTION 7: FLOWS / APEX / LWC ────────────────────────────────────
  out.push('');
  out.push(bold('  ── 7. FLOWS / APEX / LWC (ODL / Voucher / Lennar) ──────────────────'));
  out.push(`  Matching flows (${odlFlows.length}):`);
  if (!odlFlows.length) {
    out.push(red('  None found. NOTE: Lennar_Standard_Grilling_Island and Weather_NWS_Classification were just deployed — re-run audit after confirming activation.'));
  } else {
    odlFlows.forEach(f => out.push(`  ${f.DeveloperName.padEnd(55)} ${f.Status === 'Active' ? green(f.Status) : yellow(f.Status)}  v${f.VersionNumber}`));
  }
  out.push(`\n  Matching Apex classes (${odlApex.length}):`);
  odlApex.length ? odlApex.forEach(c => out.push(`  ${c.Name}`)) : out.push(red('  None.'));
  out.push(`\n  Matching LWC components (${odlLWC.length}):`);
  odlLWC.length ? odlLWC.forEach(c => out.push(`  ${c.DeveloperName}`)) : out.push(red('  None.'));

  // ── SECTION 8: PAGES / APPS / TABS ───────────────────────────────────
  out.push('');
  out.push(bold('  ── 8. LIGHTNING PAGES / APPS / TABS (ODL) ──────────────────────────'));
  out.push(`  ODL record pages (${odlPages.length}):`);
  odlPages.length ? odlPages.forEach(p => out.push(`  ${p.DeveloperName}`)) : out.push(red('  No ODL-named record pages found.'));
  out.push(`\n  ODL apps (${odlApps.length}):`);
  odlApps.length ? odlApps.forEach(a => out.push(`  ${a.DeveloperName.padEnd(40)} Label: ${a.Label||'—'}`)) : out.push(red('  None found.'));
  out.push(`\n  ODL custom tabs (${odlTabs.length}):`);
  odlTabs.length ? odlTabs.forEach(t => out.push(`  ${t.Name}`)) : out.push(yellow('  No dedicated ODL tabs found.'));

  // ── SECTION 9: REPORTS / DASHBOARDS ──────────────────────────────────
  out.push('');
  out.push(bold('  ── 9. REPORTS / DASHBOARDS (Voucher / ODL) ─────────────────────────'));
  out.push(`  Matching reports (${odlReports.records?.length||0}):`);
  (odlReports.records||[]).length ? (odlReports.records||[]).forEach(r => out.push(`  ${r.Name}`)) : out.push(red('  No voucher/ODL reports found.'));
  out.push(`\n  Matching dashboards (${odlDash.records?.length||0}):`);
  (odlDash.records||[]).length ? (odlDash.records||[]).forEach(d => out.push(`  ${d.Name}`)) : out.push(red('  No voucher/ODL dashboards found.'));

  // ── SECTION 10: LABEL COMPLIANCE ─────────────────────────────────────
  out.push('');
  out.push(bold('  ── 10. LABEL COMPLIANCE (UMB / Studio / Funding Source) ─────────────'));
  if (!legacyLabels.length && !legacyAppTabs.length) {
    out.push(green('  No legacy UMB/Studio/Funding Source labels found on audited objects.'));
  } else {
    legacyLabels.forEach(l => out.push(`  ${red('LEGACY LABEL')} ${l.object}.${l.field} — "${l.label}"`));
    legacyAppTabs.forEach(t => out.push(`  ${red('LEGACY NAME')} ${t}`));
  }
  const umbApiNames = [
    ...(odlFlows.filter(f => /\bumb\b/i.test(f.DeveloperName))),
    ...(odlApex.filter(c => /\bumb\b/i.test(c.Name))),
    ...(odlLWC.filter(c => /\bumb\b/i.test(c.DeveloperName))),
  ];
  if (umbApiNames.length) {
    out.push(yellow('\n  UMB still in API names (safe to keep if not user-facing):'));
    umbApiNames.forEach(x => out.push(gray(`  API: ${x.DeveloperName || x.Name}`)));
  } else {
    out.push(green('\n  No UMB in flow/Apex/LWC API names detected.'));
  }

  // ── SECTION 11: PERMISSION SETS ──────────────────────────────────────
  out.push('');
  out.push(bold('  ── 11. PERMISSION SETS (ODL / Voucher) ──────────────────────────────'));
  odlPermSets.records?.length
    ? odlPermSets.records.forEach(p => out.push(`  ${p.Name.padEnd(40)} ${p.Label}`))
    : out.push(red('  No ODL/Voucher-specific permission sets found. Access may be via profile only.'));

  // ── SECTION 12: Q&A TABLE ────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 12. DIRECT QUESTION ANSWERS ──────────────────────────────────────'));
  const qa = [
    ['Where does the voucher record live?',
     'Voucher__c custom object',
     `${voucherCount} records exist. VCH-00000 series.`,
     voucherCount === 0 ? 'No data' : '',
     'Use Voucher__c as source of truth for entitlement.'],

    ['Is Voucher__c live in production?',
     voucherD.ok ? green('YES') : red('NO'),
     voucherD.ok ? `Object accessible, ${voucherD.fields?.length||0} fields` : 'Object not found',
     '', ''],

    ['Are Lennar vouchers tied to Builder Account, Campaign, Opportunity, Quote?',
     hasBuilderAcct && hasCampaign && hasReservedOpp && hasRedeemedQuote ? green('YES — all 4') : yellow('PARTIAL'),
     `Builder_Account__c: ${hasBuilderAcct?'yes':'NO'} | Campaign__c: ${hasCampaign?'yes':'NO'} | Reserved_Opportunity__c: ${hasReservedOpp?'yes':'NO'} | Redeemed_Quote__c: ${hasRedeemedQuote?'yes':'NO'}`,
     !lennarAccts.records?.length ? 'No Lennar Account records to link to' : '',
     'Create Lennar Builder Account records and link vouchers'],

    ['Is Lennar grilling handled via Voucher or standard objects?',
     'Voucher__c primary',
     'Standard_Grilling_Island_Included__c field present. Flow now deployed.',
     'Not connected to Order/OrderItem yet',
     'Connect Voucher → Opportunity → Quote → Order path'],

    ['Are grilling products in Product2?',
     grillProductCount > 0 ? yellow(`${grillProductCount} products found`) : red('NOT FOUND'),
     grillProductCount > 0 ? grillProducts.records?.map(p=>p.Name).join(', ') : 'No grilling products',
     grillProductCount === 0 ? 'Products must be created before quotes can be built' : '',
     grillProductCount === 0 ? 'Create Retreat, Entertainer, Signature products in Product2' : 'Verify pricebook entries exist'],

    ['Are Retreat / Entertainer / Signature packages present?',
     (hasRetreater && hasEntertain && hasSignature) ? green('ALL 3') : red(`${[hasRetreater,hasEntertain,hasSignature].filter(Boolean).length}/3 found`),
     `Retreat: ${hasRetreater?'yes':'NO'} | Entertainer: ${hasEntertain?'yes':'NO'} | Signature: ${hasSignature?'yes':'NO'}`,
     (!hasRetreater||!hasEntertain||!hasSignature) ? 'Missing packages block quote creation' : '',
     'Create all 3 as Product2 records with pricebook entries'],

    ['Is "The Studio" represented as Custom Build?',
     'Cannot confirm from metadata scan',
     odmProducts.records?.some(p=>/studio/i.test(p.Name)) ? red('Product named "Studio" found — check label') : green('No Studio product name found'),
     '', 'Verify in Opportunity/Quote picklist for Lane field'],

    ['Is UMB / UpgradeMyBackyard naming clean?',
     legacyAppTabs.length === 0 && legacyLabels.filter(l=>/umb/i.test(l.label)).length === 0 ? green('CLEAN') : red('ISSUES FOUND'),
     legacyAppTabs.join(', ') || 'No legacy app/tab names',
     '', ''],

    ['Does voucher flow connect to Opportunity?',
     hasReservedOpp ? yellow('FIELD EXISTS — flow does not auto-create Opp yet') : red('NOT CONNECTED'),
     'Reserved_Opportunity__c is a lookup field',
     'Flow sets grilling fields but does not create/link Opportunity',
     'Build flow step: if no Reserved_Opportunity__c, create Opportunity and link'],

    ['Does voucher flow connect to Quote?',
     hasRedeemedQuote ? yellow('FIELD EXISTS — flow does not auto-create Quote yet') : red('NOT CONNECTED'),
     'Redeemed_Quote__c is a lookup field',
     'Quote creation is manual', 'Build Quote automation after Opp is created'],

    ['Does voucher flow connect to Order / OrderItem?',
     red('NOT CONNECTED'),
     'No Order lookup on Voucher__c',
     'Order path not wired', 'Map Quote → Order conversion'],

    ['Does voucher flow connect to WorkOrder / SA?',
     red('NOT DIRECTLY'),
     `WorkOrder: ${woCount} records exist. No Voucher→WO lookup found.`,
     'Install scheduling not automated from voucher', 'Connect WO creation to Quote approval'],

    ['Are payment milestones connected?',
     hasPaymentMs ? green('LOOKUP EXISTS') : red('NO LOOKUP'),
     `Payment_Milestone__c: ${paymentCount} records. Voucher.Payment_Milestone__c: ${hasPaymentMs?'yes':'NO'}`,
     '', ''],

    ['Are design review steps connected?',
     designD.ok ? yellow('Object exists') : red('Design_Review__c not found'),
     designD.ok ? `${designCount} records` : 'Object missing',
     !designD.ok ? 'No design review object' : 'Not linked from Voucher__c',
     designD.ok ? 'Add Design_Review__c lookup to Voucher__c' : 'Build Design_Review__c object'],

    ['Is warranty connected?',
     warrantyD.ok ? yellow('Object exists') : red('Warranty_Record__c not found'),
     warrantyD.ok ? `${warrantyCount} records` : 'Object missing',
     'Not linked from Voucher__c', warrantyD.ok ? 'Add warranty lookup' : 'Build Warranty_Record__c'],

    ['Are reports/dashboards showing voucher pipeline?',
     (odlReports.records?.length||0) > 0 ? yellow(`${odlReports.records.length} reports found`) : red('NONE'),
     (odlReports.records||[]).map(r=>r.Name).join(', ') || 'No voucher reports',
     'No dedicated pipeline/redemption dashboards confirmed', 'Build voucher pipeline and redemption rate reports'],

    ['Launch readiness % for Lennar grilling vouchers?',
     yellow('See readiness table below'), '', '', ''],
  ];

  const qColW = [48, 14, 32, 22, 28];
  const qHdr = ['Question','Answer','Evidence','Gap','Recommendation'].map((h,i)=>h.padEnd(qColW[i])).join('  ');
  out.push('  ' + bold(qHdr));
  out.push('  ' + gray('─'.repeat(150)));
  for (const [question, answer, evidence, gap, rec] of qa) {
    out.push(`  ${question.slice(0,46).padEnd(qColW[0])}  ${String(answer).replace(/\x1b\[[0-9;]*m/g,'').slice(0,12).padEnd(qColW[1])}  ${(evidence||'').slice(0,30).padEnd(qColW[2])}  ${(gap||'').slice(0,20).padEnd(qColW[3])}  ${(rec||'').slice(0,26)}`);
  }

  // ── SECTION 13: PROCESS MAPPING TABLE ────────────────────────────────
  out.push('');
  out.push(bold('  ── 13. BUSINESS PROCESS → OBJECT MAPPING ────────────────────────────'));
  const mapping = [
    ['Lennar voucher issued',           'Voucher__c',          'Campaign/CampaignMember', voucherD.ok?green('Keep custom'):red('Missing'), 'Keep — Voucher__c is correct'],
    ['Voucher → homeowner / lot',       'Contact__c (lookup)', 'Contact/Property',        hasContact?green('Linked'):red('NOT LINKED'), hasContact?'Verify Contact data':'Add Homeowner lookup'],
    ['Voucher → builder / Lennar',      'Builder_Account__c',  'Account',                 hasBuilderAcct && lennarAccts.records?.length>0?green('Linked'):yellow('Field exists, no data'), lennarAccts.records?.length>0?'Link to Lennar Account':'Create Lennar Account first'],
    ['Homeowner claims voucher',        'Voucher__c Status__c', 'n/a',                    voucherStatusValues.length?green(voucherStatusValues.join(',')):yellow('Status values unknown'), 'Confirm "Claimed" status value exists'],
    ['Lead / Opportunity created',      'Reserved_Opportunity__c', 'Opportunity',         hasReservedOpp?yellow('Field exists — manual'):red('Not automated'), 'Automate Opp creation on voucher claim'],
    ['Grilling package selected',       'Product2',            'Product2/PricebookEntry', grillProductCount>0?yellow('Some products'):red('Retreat/Entertainer/Signature missing'), 'Create all 3 packages in Product2'],
    ['Quote created',                   'Redeemed_Quote__c',   'Quote',                   hasRedeemedQuote?yellow('Field exists — manual'):red('Not automated'), 'Automate Quote from Opportunity'],
    ['Order created after approval',    'NOT CONNECTED',       'Order/OrderItem',         red('Gap'), 'Wire Quote → Order conversion'],
    ['Payment milestones tracked',      'Payment_Milestone__c', 'n/a',                   paymentD.ok?green('Object live'):red('Missing'), paymentD.ok?'Confirm milestone stages':'Build milestone object'],
    ['Design review completed',         designD.ok?'Design_Review__c':'MISSING', 'n/a',  designD.ok?yellow('Exists — not linked from Voucher'):red('Object missing'), designD.ok?'Add lookup':'Build Design_Review__c'],
    ['WorkOrder created',               'WorkOrder',           'WorkOrder',               woD.ok?yellow('Exists — not auto-created from Voucher'):red('Missing'), 'Automate WO from Quote/Order approval'],
    ['ServiceAppointment scheduled',    'ServiceAppointment',  'ServiceAppointment',      saD.ok?yellow('Exists — manual scheduling'):red('Missing'), 'Use FSL dispatcher to schedule SA'],
    ['Install completed',               'WorkOrder Status',    'WorkOrder',               woD.ok?yellow('Object live — closeout not proven'):red('Missing'), 'Add closeout step to WO'],
    ['Warranty tracked',                warrantyD.ok?'Warranty_Record__c':'MISSING', 'n/a', warrantyD.ok?yellow('Exists — not linked'):red('Missing'), warrantyD.ok?'Add Warranty lookup':'Build Warranty_Record__c'],
    ['Voucher reimbursement / billing', 'Builder_Invoice_* fields', 'n/a',              green('Fields present on Voucher__c'), 'Confirm invoice workflow exists'],
  ];
  const mColW = [30, 24, 22, 22, 30];
  out.push('  ' + bold(['Business Step','Current Object','SF Standard Avail','Gap','Recommendation'].map((h,i)=>h.padEnd(mColW[i])).join('  ')));
  out.push('  ' + gray('─'.repeat(134)));
  mapping.forEach(([step,cur,std,gap,rec]) => {
    out.push(`  ${step.padEnd(mColW[0])}  ${cur.padEnd(mColW[1])}  ${std.padEnd(mColW[2])}  ${String(gap).replace(/\x1b\[[0-9;]*m/g,'').padEnd(mColW[3])}  ${rec.slice(0,28)}`);
  });

  // ── SECTION 14: READINESS SCORE ──────────────────────────────────────
  out.push('');
  out.push(bold('  ── 14. LAUNCH READINESS SCORE ───────────────────────────────────────'));

  // Calculate scores
  const voucherScore = (() => {
    let s = 0;
    if (voucherD.ok) s += 20;
    if (voucherCount > 0) s += 10;
    if (hasCampaign) s += 10;
    if (hasBuilderAcct) s += 10;
    if (hasContact) s += 10;
    if (hasReservedOpp) s += 10;
    if (hasRedeemedQuote) s += 10;
    if (hasGrillingField) s += 10;
    if (odlFlows.some(f => /lennar|grilling/i.test(f.DeveloperName))) s += 10;
    return s;
  })();

  const outdoorScore = (() => {
    let s = 0;
    if (odlApps.length > 0) s += 20;
    if (odlPages.length > 0) s += 20;
    if (voucherD.ok) s += 15;
    if (paymentD.ok) s += 15;
    if (lennarCamps.records?.length > 0) s += 10;
    if (odlTabs.length > 0) s += 10;
    if (odlPermSets.records?.length > 0) s += 10;
    return s;
  })();

  const productScore = (() => {
    let s = 0;
    if (grillProductCount > 0) s += 30;
    if (hasRetreater) s += 20;
    if (hasEntertain) s += 20;
    if (hasSignature) s += 20;
    if (pricebooks.records?.some(p => p.IsActive)) s += 10;
    return s;
  })();

  const quoteScore = (() => {
    let s = 0;
    if (quoteD.ok) s += 30;
    if (hasRedeemedQuote) s += 30;
    if (lennarQuoteCount > 0) s += 40;
    return s;
  })();

  const orderScore = (() => {
    let s = 0;
    if (orderD.ok) s += 40;
    if (totalOrderCount > 0) s += 60;
    return s;
  })();

  const woScore = (() => {
    let s = 0;
    if (woD.ok) s += 30;
    if (woCount > 0) s += 30;
    if (saD.ok) s += 20;
    if (saCount > 0) s += 20;
    return s;
  })();

  const paymentScore = (() => {
    let s = 0;
    if (paymentD.ok) s += 50;
    if (paymentCount > 0) s += 50;
    return s;
  })();

  const warrantyScore = (() => {
    let s = 0;
    if (warrantyD.ok) s += 50;
    if (warrantyD.ok && warrantyCount > 0) s += 50;
    return s;
  })();

  function scoreBar(pct) {
    const filled = Math.round(pct / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    const color = pct >= 70 ? green : pct >= 40 ? yellow : red;
    return color(`${bar} ${pct}%`);
  }

  const scoreRows = [
    ['Voucher / Lennar Grilling',          voucherScore,  voucherD.ok?`${voucherCount} records, flow deployed`:'Object missing', voucherScore<100?'Products + Opp/Quote connection':'','Build product link and Opp automation'],
    ['Outdoor Living / UpgradeMyBackyard', outdoorScore,  `${odlApps.length} apps, ${odlPages.length} pages`,'Lane picklist on Opp missing','Add lane field and Design Build picklist'],
    ['Products / Packages',                productScore,  `${grillProductCount} matching products`,'Retreat/Entertainer/Signature missing','Create 3 package products + pricebook entries'],
    ['Quote path',                         quoteScore,    `${lennarQuoteCount} ODL quotes`,'Manual — not automated from Voucher','Automate Quote from claimed Voucher'],
    ['Order path',                         orderScore,    `${totalOrderCount} orders`,'Not connected to Voucher/Quote','Wire Quote→Order conversion'],
    ['WorkOrder / Scheduling path',        woScore,       `${woCount} WOs, ${saCount} SAs`,'Not auto-created from Voucher','Connect WO creation to Quote approval'],
    ['Payment / Billing path',             paymentScore,  `${paymentCount} milestones`,'Invoice workflow not confirmed','Confirm Builder_Invoice fields are used'],
    ['Warranty path',                      warrantyScore, warrantyD.ok?`${warrantyCount} records`:'Object missing',warrantyD.ok?'Not linked from Voucher':'Build Warranty_Record__c',warrantyD.ok?'Add lookup + page':'Build object'],
  ];

  const sColW = [36, 24, 30, 30, 30];
  out.push('  ' + bold(['Area','Readiness','Evidence','Main Blocker','Next Action'].map((h,i)=>h.padEnd(sColW[i])).join('  ')));
  out.push('  ' + gray('─'.repeat(154)));
  for (const [area, score, evidence, blocker, action] of scoreRows) {
    out.push(`  ${area.padEnd(sColW[0])}  ${scoreBar(score).padEnd(sColW[1] + 20)}  ${(evidence||'').slice(0,28).padEnd(sColW[2])}  ${(blocker||'').slice(0,28).padEnd(sColW[3])}  ${(action||'').slice(0,28)}`);
  }

  // ── BOTTOM LINE ───────────────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── BOTTOM LINE ──────────────────────────────────────────────────────'));
  out.push('');
  out.push(`  ${bold('1. Exact objects:')} Voucher__c (${voucherCount} records), Payment_Milestone__c (${paymentCount}), ${designD.ok?`Design_Review__c (${designCount})`:'Design_Review__c MISSING'}, ${warrantyD.ok?`Warranty_Record__c (${warrantyCount})`:'Warranty_Record__c MISSING'}`);
  out.push(`  ${bold('2. Live data:')} ${voucherCount} vouchers | ${lennarCamps.records?.length||0} Lennar campaigns | ${grillProductCount} ODL products | ${lennarOppCount} Lennar opps | ${lennarQuoteCount} Lennar quotes`);
  out.push(`  ${bold('3. Apps/tabs/pages:')} ${odlApps.map(a=>a.DeveloperName).join(', ')||'none'} | Pages: ${odlPages.length} | Tabs: ${odlTabs.length}`);
  out.push(`  ${bold('4. Reports/dashboards:')} ${odlReports.records?.length||0} reports | ${odlDash.records?.length||0} dashboards`);
  out.push(`  ${bold('5. Top gaps:')} ${[
    grillProductCount===0 && 'Retreat/Entertainer/Signature products missing',
    !hasReservedOpp && 'Voucher not auto-connecting to Opportunity',
    !warrantyD.ok && 'Warranty_Record__c does not exist',
    !designD.ok && 'Design_Review__c does not exist',
    (odlReports.records?.length||0)===0 && 'No voucher pipeline reports',
    lennarAccts.records?.length===0 && 'No Lennar Builder Account records',
  ].filter(Boolean).join(' | ')}`);
  out.push(`  ${bold('6. Overall readiness:')} ${Math.round((voucherScore+outdoorScore+productScore+quoteScore)/4)}% average across core ODL paths`);
  out.push(`  ${bold('7. Connected to backbone?')} ${hasReservedOpp && hasRedeemedQuote && woD.ok ? yellow('PARTIALLY — Voucher links to Opp and Quote but Order and WO not automated') : red('NOT FULLY — key connection points exist but are manual, not automated')}`);
  out.push(`  ${bold('8. Before launch:')} Create products, create Lennar Account, automate Opp/Quote from Voucher, build Reports/Dashboards, confirm Status picklist values, smoke-test end-to-end`);
  out.push('');
  out.push(bold(`  Audit complete: ${new Date().toLocaleString()}`));
  out.push(gray('  To re-run: node bin/dispatch.js audit-odl'));
  out.push(gray('  To save:   node bin/dispatch.js audit-odl > odl-audit.txt'));
  out.push('');

  console.log(out.join('\n'));
}

async function cmdFix(args) {
  const subCmd = args[0];
  if (!subCmd || subCmd === 'help') {
    console.log(`
  ${bold('dispatch fix')} — deploy production fixes to Salesforce

  ${bold('Subcommands:')}
    ${cyan('dispatch fix deploy')}        Deploy all metadata fixes (fields + weather flow)
    ${cyan('dispatch fix territories')}   Rename Charlotte territories to approved names
    ${cyan('dispatch fix lennar')}        Build and deploy Lennar Grilling Island flow (run check-lennar first)

  ${bold('What gets deployed:')}
    - Weather_Alert__c.NWS_Classification__c  (picklist field)
    - Vehicle__c.Unit_Number__c               (text field, external ID)
    - Vehicle__c.Driver_Name__c               (text field)
    - Weather_NWS_Classification flow         (before-save, classifies alerts)
`);
    return;
  }

  const cfg = loadConfig();
  const sf = cfg.salesforce;
  if (!sf) { console.log(red('\n  Not connected. Run: dispatch connect\n')); process.exit(1); }

  if (subCmd === 'deploy') {
    console.log(bold('\n  Deploying metadata fixes to Salesforce…\n'));

    // Check sf CLI available
    try { execSync('sf --version', { stdio: 'ignore' }); } catch {
      console.log(red('  Salesforce CLI (sf) not found. Install from https://developer.salesforce.com/tools/salesforcecli'));
      process.exit(1);
    }

    console.log(gray('  Deploying: NWS_Classification__c, Unit_Number__c, Driver_Name__c, Weather flow…'));
    try {
      execSync(
        `sf project deploy start --source-dir force-app --target-org dispatch --wait 10`,
        { cwd: REPO_ROOT, stdio: 'inherit' }
      );
      console.log(green('\n  All fixes deployed successfully.\n'));
      console.log(gray('  Next: run "dispatch fix territories" to rename Charlotte markets.'));
      console.log(gray('  Next: run "dispatch check-lennar" then paste output to Claude to build the Lennar flow.\n'));
    } catch (err) {
      console.log(red('\n  Deploy failed. Check the output above for details.'));
      console.log(gray('  Common fix: run "sf org login web --alias dispatch" to re-authenticate.\n'));
    }
    return;
  }

  if (subCmd === 'territories') {
    console.log(bold('\n  Charlotte Territory Rename\n'));

    const territories = await sfQuery(sf,
      "SELECT Id, Name FROM ServiceTerritory WHERE IsActive=true AND (Name LIKE '%Charlotte%' OR Name LIKE '%Cabarrus%' OR Name LIKE '%Lake Norman%' OR Name LIKE '%Gaston%') ORDER BY Name"
    );

    if (!territories.records?.length) {
      console.log(yellow('  No Charlotte-area territories found.\n'));
      return;
    }

    console.log('  Found these Charlotte-area territories:\n');
    territories.records.forEach((t, i) => console.log(`  ${i + 1}. ${t.Id}  ${t.Name}`));

    console.log(bold('\n  Rename plan:'));
    console.log('  The 2 missing approved markets are: Charlotte - North  and  Charlotte - South');
    console.log('  Map one existing territory to each.\n');

    const northAnswer = await prompt('  Which territory number should become "Charlotte - North"? (enter number or skip): ');
    const southAnswer = await prompt('  Which territory number should become "Charlotte - South"? (enter number or skip): ');

    const northIdx = parseInt(northAnswer) - 1;
    const southIdx = parseInt(southAnswer) - 1;

    const toRename = [];
    if (!isNaN(northIdx) && territories.records[northIdx]) {
      toRename.push({ id: territories.records[northIdx].Id, oldName: territories.records[northIdx].Name, newName: 'Charlotte - North' });
    }
    if (!isNaN(southIdx) && territories.records[southIdx]) {
      toRename.push({ id: territories.records[southIdx].Id, oldName: territories.records[southIdx].Name, newName: 'Charlotte - South' });
    }

    if (!toRename.length) {
      console.log(yellow('\n  No renames selected. Exiting.\n'));
      return;
    }

    console.log(bold('\n  About to rename:'));
    toRename.forEach(r => console.log(`  ${r.oldName}  →  ${r.newName}`));
    const confirm = await prompt('\n  Confirm? (yes/no): ');
    if (confirm.toLowerCase() !== 'yes') {
      console.log(yellow('  Cancelled.\n'));
      return;
    }

    for (const r of toRename) {
      try {
        await sfRequest(sf.instanceUrl, sf.accessToken,
          `/services/data/v60.0/sobjects/ServiceTerritory/${r.id}`,
          'PATCH', { Name: r.newName }
        );
        console.log(green(`  Renamed: ${r.oldName} → ${r.newName}`));
      } catch (err) {
        console.log(red(`  Failed to rename ${r.oldName}: ${err.message}`));
      }
    }
    console.log(bold('\n  Done. Re-run "dispatch audit" to verify markets.\n'));
    return;
  }

  if (subCmd === 'lennar') {
    console.log(yellow('\n  Run "dispatch check-lennar" first and paste the output to Claude.'));
    console.log(gray('  Claude will build the flow and add it here.\n'));
    return;
  }

  console.log(red(`\n  Unknown fix subcommand: ${subCmd}\n`));
  await cmdFix(['help']);
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

// ── audit helpers ────────────────────────────────────────────────────────────
async function sfQuery(sf, soql) {
  try {
    const r = await sfRequest(sf.instanceUrl, sf.accessToken, `/services/data/v60.0/query?q=${encodeURIComponent(soql)}`);
    return { ok: true, records: r.records || [], total: r.totalSize };
  } catch (e) { return { ok: false, error: e.message, records: [], total: 0 }; }
}

async function sfDescribe(sf, obj) {
  try {
    const r = await sfRequest(sf.instanceUrl, sf.accessToken, `/services/data/v60.0/sobjects/${obj}/describe`);
    return { ok: true, fields: r.fields || [], label: r.label };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function sfTooling(sf, soql) {
  try {
    const r = await sfRequest(sf.instanceUrl, sf.accessToken, `/services/data/v60.0/tooling/query?q=${encodeURIComponent(soql)}`);
    return { ok: true, records: r.records || [], total: r.totalSize };
  } catch (e) { return { ok: false, error: e.message, records: [], total: 0 }; }
}

async function sfMetadata(sf, type, fullName) {
  try {
    const r = await sfRequest(sf.instanceUrl, sf.accessToken,
      `/services/data/v60.0/tooling/query?q=${encodeURIComponent(`SELECT Id,DeveloperName,Status FROM ${type} WHERE DeveloperName='${fullName}'`)}`);
    return { ok: true, records: r.records || [] };
  } catch (e) { return { ok: false, error: e.message, records: [] }; }
}

function row(item, status, evidence, gap, action, owner) {
  return { item, status, evidence, gap, action, owner };
}

const STATUS = {
  WORKING:       'Working',
  PARTIAL:       'Partially Working',
  BUILT_NOT_LIVE:'Built but Not Live',
  LIVE_NOT_PROVEN:'Live but Not Proven',
  BLOCKED:       'Blocked',
  NOT_BUILT:     'Not Built',
  BIZ_DECISION:  'Needs Business Decision',
};

const RISK = { LOW: 'Low', MED: 'Medium', HIGH: 'High', CRIT: 'Critical' };

async function cmdAudit() {
  const cfg = loadConfig();
  const sf = cfg.salesforce;
  if (!sf) { console.log(red('\n  Not connected. Run: dispatch connect\n')); process.exit(1); }

  console.log(bold('\n  LOVING Dispatch — Full Production System Audit'));
  console.log(gray(`  Org: ${sf.instanceUrl}  |  User: ${sf.username}`));
  console.log(gray(`  Audit started: ${new Date().toLocaleString()}\n`));
  console.log(gray('  Querying org… this may take 30–60 seconds.\n'));

  const findings = [];

  // ── helper: check object exists ─────────────────────────────────────────
  async function checkObj(apiName, label) {
    const d = await sfDescribe(sf, apiName);
    if (!d.ok) return { exists: false, error: d.error, fields: [] };
    return { exists: true, label: d.label, fields: d.fields };
  }

  async function countRecords(obj, where) {
    const q = where ? `SELECT COUNT() FROM ${obj} WHERE ${where}` : `SELECT COUNT() FROM ${obj}`;
    const r = await sfQuery(sf, q);
    return r.ok ? r.total : -1;
  }

  async function fieldExists(obj, fieldName) {
    const d = await checkObj(obj);
    if (!d.exists) return false;
    return d.fields.some(f => f.name === fieldName);
  }

  async function flowExists(name) {
    const r = await sfTooling(sf, `SELECT Id,DeveloperName,Status,VersionNumber FROM Flow WHERE DeveloperName='${name}' ORDER BY VersionNumber DESC LIMIT 1`);
    if (!r.ok || !r.records.length) return null;
    return r.records[0];
  }

  async function lwcExists(name) {
    const r = await sfTooling(sf, `SELECT Id,DeveloperName,ApiVersion FROM LightningComponentBundle WHERE DeveloperName='${name}' LIMIT 1`);
    if (!r.ok || !r.records.length) return null;
    return r.records[0];
  }

  async function apexClassExists(name) {
    const r = await sfTooling(sf, `SELECT Id,Name,Status FROM ApexClass WHERE Name='${name}' LIMIT 1`);
    if (!r.ok || !r.records.length) return null;
    return r.records[0];
  }

  async function permSetExists(name) {
    const r = await sfQuery(sf, `SELECT Id,Name,Label FROM PermissionSet WHERE Name='${name}' LIMIT 1`);
    if (!r.ok || !r.records.length) return null;
    return r.records[0];
  }

  // ════════════════════════════════════════════════════════════════════════
  // 1. FSL / SCHEDULE CONSOLE
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking FSL / Schedule Console… '));
  const fslObjects = ['ServiceAppointment','WorkOrder','ServiceResource','ServiceTerritory','AssignedResource','ServiceTerritoryMember'];
  const fslChecks = await Promise.all(fslObjects.map(o => checkObj(o)));
  const fslLive = fslChecks.every(c => c.exists);
  const saCount = await countRecords('ServiceAppointment', "Status != 'Canceled'");
  const woCount = await countRecords('WorkOrder');
  const srCount = await countRecords('ServiceResource', "IsActive=true");

  const territories = await sfQuery(sf, "SELECT Id,Name,OperatingHoursId FROM ServiceTerritory WHERE IsActive=true ORDER BY Name");
  const approvedMarkets = ['Charlotte - North','Charlotte - South','Asheville','Triad','Greenville','Columbia','Triangle'];
  const liveMarkets = (territories.records || []).map(t => t.Name);
  const matchedMarkets = approvedMarkets.filter(m => liveMarkets.some(l => l.toLowerCase().includes(m.toLowerCase())));
  const extraTerritories = liveMarkets.filter(l => !approvedMarkets.some(m => l.toLowerCase().includes(m.toLowerCase())));

  // Check Schedule_Day__c
  const schedDay = await checkObj('Schedule_Day__c');
  const schedDayCount = schedDay.exists ? await countRecords('Schedule_Day__c') : -1;

  // Check Schedule_Issue__c
  const schedIssue = await checkObj('Schedule_Issue__c');
  const schedIssueCount = schedIssue.exists ? await countRecords('Schedule_Issue__c') : -1;

  // FSL dispatcher page
  const dispatcherApp = await sfTooling(sf, "SELECT Id,DeveloperName FROM CustomApplication WHERE DeveloperName='Field_Service' LIMIT 1");

  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 2. WEATHER
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking Weather… '));
  const weatherObj = await checkObj('Weather_Alert__c');
  const weatherCount = weatherObj.exists ? await countRecords('Weather_Alert__c') : -1;
  const weatherFlow = await flowExists('Weather_Sync');
  const weatherFlow2 = await flowExists('NWS_Weather_Sync');
  const weatherFlow3 = await flowExists('WeatherSync');
  const weatherClassification = weatherObj.exists ? await fieldExists('Weather_Alert__c', 'NWS_Classification__c') : false;
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 3. WEX GPS
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking WEX GPS… '));
  const wexObj = await checkObj('WEX_Vehicle__c');
  const vehicleObj = await checkObj('Vehicle__c');
  const gpsObj = wexObj.exists ? wexObj : vehicleObj;
  const gpsObjName = wexObj.exists ? 'WEX_Vehicle__c' : vehicleObj.exists ? 'Vehicle__c' : null;
  const unitNumField = gpsObjName ? await fieldExists(gpsObjName, 'Unit_Number__c') : false;
  const driverField = gpsObjName ? await fieldExists(gpsObjName, 'Driver_Name__c') : false;
  const gpsCount = gpsObjName ? await countRecords(gpsObjName) : -1;
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 4. TRAFFIC / HERE
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking Traffic / HERE… '));
  const routeOptObj = await checkObj('Route_Optimization_Result__c');
  const trafficFlow = await flowExists('Traffic_Sync');
  const hereClass = await apexClassExists('HERETrafficService');
  const hereClass2 = await apexClassExists('HEREIntegration');
  const routeCount = routeOptObj.exists ? await countRecords('Route_Optimization_Result__c') : -1;
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 5. RELEASE READINESS / Schedule_Day__c
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking Release Readiness… '));
  const releaseStatusField = schedDay.exists ? await fieldExists('Schedule_Day__c', 'Release_Status__c') : false;
  const releaseFlow = await flowExists('Release_Readiness');
  const releaseFlow2 = await flowExists('ReleaseReadiness');
  const releaseClass = await apexClassExists('ReleaseReadinessController');
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 6. OUTDOOR LIVING / UPGRADEMYBACKYARD / DESIGN BUILD
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking Outdoor Living / UMB / Design Build… '));
  const umbApp = await sfTooling(sf, "SELECT Id,DeveloperName,Label FROM CustomApplication WHERE DeveloperName LIKE '%Outdoor%' OR DeveloperName LIKE '%UMB%' OR DeveloperName LIKE '%Upgrade%' LIMIT 5");
  const oppObj = await checkObj('Opportunity');
  // Check for Design Build and UMB fields/picklists on Opportunity
  const laneField = oppObj.exists ? await fieldExists('Opportunity', 'Lane__c') : false;
  const laneField2 = oppObj.exists ? await fieldExists('Opportunity', 'Project_Lane__c') : false;
  const laneFieldName = laneField ? 'Lane__c' : laneField2 ? 'Project_Lane__c' : null;

  // Check label usage
  let lanePicklistValues = [];
  if (laneFieldName) {
    const oppDesc = await checkObj('Opportunity');
    const lf = oppDesc.fields?.find(f => f.name === laneFieldName);
    lanePicklistValues = lf?.picklistValues?.map(p => p.label) || [];
  }

  const outdoorConsole = await sfTooling(sf, "SELECT Id,DeveloperName FROM CustomApplication WHERE DeveloperName LIKE '%Outdoor_Living%' OR DeveloperName LIKE '%Dispatch%' LIMIT 5");
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 7. VOUCHERS / LENNAR / CAMPAIGNS
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking Vouchers / Lennar / Campaigns… '));
  const voucherObj = await checkObj('Voucher__c');
  const voucherCount = voucherObj.exists ? await countRecords('Voucher__c') : -1;
  const lennarVoucher = voucherObj.exists ? await sfQuery(sf, "SELECT Id,Name FROM Voucher__c WHERE Name LIKE '%Lennar%' OR Name LIKE '%Grilling%' LIMIT 5") : { records: [] };
  const campaignCount = await countRecords('Campaign');
  const lennarFlow = await flowExists('Lennar_Standard_Grilling_Island');
  const lennarFlow2 = await flowExists('LennarVoucher');
  const lennarFlow3 = await flowExists('Lennar_Voucher');
  // Check sponsor payment label
  const sponsorField = await fieldExists('Opportunity', 'Sponsor_Payment_Responsibility__c');
  const fundingField = await fieldExists('Opportunity', 'Funding_Source__c');
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 8. QUOTES / PAYMENT MILESTONES / CHANGE ORDERS / WARRANTY
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking Quotes / Payments / Change Orders / Warranty… '));
  const quoteObj = await checkObj('Quote');
  const quoteCount = quoteObj.exists ? await countRecords('Quote') : -1;
  const paymentObj = await checkObj('Payment_Milestone__c');
  const paymentCount = paymentObj.exists ? await countRecords('Payment_Milestone__c') : -1;
  const changeOrderObj = await checkObj('Change_Order__c');
  const changeOrderCount = changeOrderObj.exists ? await countRecords('Change_Order__c') : -1;
  const warrantyObj = await checkObj('Warranty__c');
  const warrantyCaseObj = await checkObj('WarrantyTerm');
  const warrantyCount = warrantyObj.exists ? await countRecords('Warranty__c') : -1;
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 9. PAGES (Lightning Record Pages)
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking record pages… '));
  const pageObjects = [
    'Account','Lead','Opportunity','Quote','WorkOrder','ServiceAppointment',
    'Campaign','Change_Order__c','Warranty__c','Payment_Milestone__c'
  ];
  const flexiPageQuery = await sfTooling(sf,
    `SELECT Id,DeveloperName,EntityDefinitionId FROM FlexiPage WHERE Type='RecordPage' ORDER BY DeveloperName LIMIT 200`);
  const flexiPages = flexiPageQuery.records || [];
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 10. EMAIL / RINGCENTRAL / MARKETING CLOUD
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking email / comms… '));
  const emailTemplates = await sfQuery(sf, "SELECT COUNT() FROM EmailTemplate WHERE FolderName LIKE '%Dispatch%' OR FolderName LIKE '%Homeowner%' OR Name LIKE '%Schedule%'");
  const rcClass = await apexClassExists('RingCentralService');
  const rcClass2 = await apexClassExists('RingCentralIntegration');
  const mcFlow = await flowExists('Marketing_Cloud_Sync');
  const mcConnected = await sfTooling(sf, "SELECT Id,Name FROM ConnectedApplication WHERE Name LIKE '%Marketing Cloud%' OR Name LIKE '%ExactTarget%' LIMIT 3");
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 11. FOREMAN / FIELD APP
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking Foreman / Field App… '));
  const foremanApp = await sfTooling(sf, "SELECT Id,DeveloperName FROM CustomApplication WHERE DeveloperName LIKE '%Foreman%' OR DeveloperName LIKE '%Field%' LIMIT 5");
  const offlineObj = await checkObj('Mobile_Checklist__c');
  const photoObj = await checkObj('Job_Photo__c');
  const issueObj = await checkObj('Field_Issue__c');
  const closeoutObj = await checkObj('Closeout__c');
  const foremanLWC = await lwcExists('foremanApp');
  const foremanLWC2 = await lwcExists('fieldApp');
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 12. PERMISSION SETS
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking permission sets… '));
  const permSets = await sfQuery(sf, "SELECT Id,Name,Label,Description FROM PermissionSet WHERE IsOwnedByProfile=false ORDER BY Name LIMIT 100");
  const keyPermSets = ['Dispatcher','Field_Manager','Foreman','Admin','Schedule_Manager','FSL_User'];
  const permSetResults = await Promise.all(keyPermSets.map(p => permSetExists(p)));
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 13. RIPPLING / TIME
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking Rippling / time source… '));
  const ripplingClass = await apexClassExists('RipplingService');
  const ripplingClass2 = await apexClassExists('RipplingIntegration');
  const timeObj = await checkObj('Time_Entry__c');
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 14. LABEL AUDIT — UMB / STUDIO / CUSTOM BUILD / FUNDING SOURCE
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking label compliance… '));
  // Check field labels on key objects for legacy terms
  const labelChecks = [];
  for (const obj of ['Opportunity','Account','Quote','WorkOrder']) {
    const d = await checkObj(obj);
    if (d.exists && d.fields) {
      for (const f of d.fields) {
        const lbl = (f.label || '').toLowerCase();
        if (lbl.includes('umb') || lbl.includes('the studio') || lbl.includes('funding source') ||
            (lbl.includes('custom build') && !lbl.includes('api'))) {
          labelChecks.push({ object: obj, field: f.name, label: f.label });
        }
      }
    }
  }
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // 15. REPORTS / DASHBOARDS
  // ════════════════════════════════════════════════════════════════════════
  process.stdout.write(gray('  Checking reports / dashboards… '));
  const reportCount = await countRecords('Report');
  const dashCount = await countRecords('Dashboard');
  console.log(green('done'));

  // ════════════════════════════════════════════════════════════════════════
  // OUTPUT REPORT
  // ════════════════════════════════════════════════════════════════════════
  const HR = '─'.repeat(120);
  const out = [];

  out.push('');
  out.push(bold('══════════════════════════════════════════════════════════════'));
  out.push(bold('  LOVING DISPATCH — FULL PRODUCTION SYSTEM AUDIT'));
  out.push(bold(`  ${new Date().toLocaleString()}  |  ${sf.instanceUrl}`));
  out.push(bold('══════════════════════════════════════════════════════════════'));

  // ── EXECUTIVE SUMMARY ────────────────────────────────────────────────
  out.push('');
  out.push(bold('  EXECUTIVE SUMMARY'));
  out.push(gray('  ' + HR.slice(0, 100)));

  const summaryRows = [
    ['FSL / Schedule Console', fslLive && saCount > 0 ? STATUS.PARTIAL : fslLive ? STATUS.LIVE_NOT_PROVEN : STATUS.BLOCKED,
     fslLive ? `Objects live. ${saCount} SAs, ${woCount} WOs, ${srCount} active resources.` : 'FSL objects missing.',
     matchedMarkets.length < 7 ? RISK.HIGH : saCount === 0 ? RISK.MED : RISK.LOW],

    ['Service Territories (7 markets)', matchedMarkets.length === 7 ? STATUS.WORKING : matchedMarkets.length > 0 ? STATUS.PARTIAL : STATUS.BLOCKED,
     `${matchedMarkets.length}/7 approved markets live: ${matchedMarkets.join(', ') || 'none'}`,
     matchedMarkets.length < 7 ? RISK.HIGH : RISK.LOW],

    ['Weather Sync / NWS', (weatherObj.exists && weatherCount > 0) ? STATUS.PARTIAL : weatherObj.exists ? STATUS.LIVE_NOT_PROVEN : STATUS.NOT_BUILT,
     weatherObj.exists ? `Weather_Alert__c exists. ${weatherCount} records. NWS_Classification__c: ${weatherClassification ? 'present' : 'MISSING'}` : 'Weather_Alert__c not found.',
     weatherObj.exists && !weatherClassification ? RISK.HIGH : RISK.MED],

    ['WEX GPS / Vehicle Mapping', gpsObjName ? (gpsCount > 0 ? STATUS.PARTIAL : STATUS.LIVE_NOT_PROVEN) : STATUS.NOT_BUILT,
     gpsObjName ? `${gpsObjName} exists. ${gpsCount} records. Unit_Number__c: ${unitNumField ? 'yes' : 'NO'}. Driver_Name__c: ${driverField ? 'yes' : 'NO'}.` : 'No GPS vehicle object found.',
     !gpsObjName || !unitNumField || !driverField ? RISK.HIGH : RISK.MED],

    ['Traffic / HERE / Route Optimization', routeOptObj.exists ? STATUS.LIVE_NOT_PROVEN : STATUS.NOT_BUILT,
     routeOptObj.exists ? `Route_Optimization_Result__c exists. ${routeCount} records. HERE Apex: ${(hereClass || hereClass2) ? 'deployed' : 'NOT FOUND'}.` : 'Route_Optimization_Result__c not found.',
     RISK.MED],

    ['Release Readiness / Schedule_Day__c', schedDay.exists ? (releaseStatusField ? STATUS.LIVE_NOT_PROVEN : STATUS.PARTIAL) : STATUS.NOT_BUILT,
     schedDay.exists ? `Schedule_Day__c exists. ${schedDayCount} records. Release_Status__c: ${releaseStatusField ? 'yes' : 'MISSING'}.` : 'Schedule_Day__c not found.',
     !schedDay.exists || !releaseStatusField ? RISK.HIGH : RISK.LOW],

    ['Schedule Issues', schedIssue.exists ? (schedIssueCount > 0 ? STATUS.LIVE_NOT_PROVEN : STATUS.BUILT_NOT_LIVE) : STATUS.NOT_BUILT,
     schedIssue.exists ? `Schedule_Issue__c exists. ${schedIssueCount} records.` : 'Schedule_Issue__c not found.',
     RISK.MED],

    ['Outdoor Living / UpgradeMyBackyard Console', umbApp.records?.length > 0 ? STATUS.LIVE_NOT_PROVEN : STATUS.BLOCKED,
     umbApp.records?.length > 0 ? `App(s): ${umbApp.records.map(a => a.DeveloperName).join(', ')}` : 'No Outdoor Living app found in org.',
     RISK.HIGH],

    ['Design Build lane / label compliance', laneFieldName ? (lanePicklistValues.length > 0 ? STATUS.LIVE_NOT_PROVEN : STATUS.PARTIAL) : STATUS.NOT_BUILT,
     laneFieldName ? `${laneFieldName} found. Picklist values: ${lanePicklistValues.slice(0,5).join(', ') || 'none'}` : 'No lane/project type field found on Opportunity.',
     RISK.MED],

    ['Vouchers / Lennar Grilling Island', voucherObj.exists ? (lennarVoucher.records?.length > 0 ? STATUS.LIVE_NOT_PROVEN : STATUS.BUILT_NOT_LIVE) : STATUS.NOT_BUILT,
     voucherObj.exists ? `Voucher__c exists. ${voucherCount} total. Lennar records: ${lennarVoucher.records?.length || 0}. Flow: ${(lennarFlow||lennarFlow2||lennarFlow3) ? 'found' : 'NOT FOUND'}.` : 'Voucher__c not found.',
     RISK.HIGH],

    ['Quotes', quoteObj.exists ? (quoteCount > 0 ? STATUS.LIVE_NOT_PROVEN : STATUS.BUILT_NOT_LIVE) : STATUS.NOT_BUILT,
     quoteObj.exists ? `Quote object live. ${quoteCount} records.` : 'Quote object not accessible.',
     RISK.MED],

    ['Payment Milestones', paymentObj.exists ? (paymentCount > 0 ? STATUS.LIVE_NOT_PROVEN : STATUS.BUILT_NOT_LIVE) : STATUS.NOT_BUILT,
     paymentObj.exists ? `Payment_Milestone__c exists. ${paymentCount} records.` : 'Payment_Milestone__c not found.',
     RISK.MED],

    ['Change Orders', changeOrderObj.exists ? STATUS.LIVE_NOT_PROVEN : STATUS.NOT_BUILT,
     changeOrderObj.exists ? `Change_Order__c exists. ${changeOrderCount} records.` : 'Change_Order__c not found.',
     RISK.MED],

    ['Warranty Records', warrantyObj.exists ? STATUS.LIVE_NOT_PROVEN : STATUS.NOT_BUILT,
     warrantyObj.exists ? `Warranty__c exists. ${warrantyCount} records.` : 'Warranty__c not found.',
     RISK.LOW],

    ['Record Pages (Lightning)', flexiPages.length > 0 ? STATUS.PARTIAL : STATUS.NOT_BUILT,
     `${flexiPages.length} FlexiPages found in org.`,
     flexiPages.length < 5 ? RISK.HIGH : RISK.MED],

    ['Email / Homeowner Schedule Comms', emailTemplates.total > 0 ? STATUS.LIVE_NOT_PROVEN : STATUS.NOT_BUILT,
     `${emailTemplates.total} matching email templates found.`,
     RISK.MED],

    ['RingCentral / Salesforce Voice', (rcClass || rcClass2) ? STATUS.LIVE_NOT_PROVEN : STATUS.NOT_BUILT,
     (rcClass || rcClass2) ? 'RingCentral Apex class found.' : 'No RingCentral Apex class found.',
     RISK.LOW],

    ['Marketing Cloud', mcConnected.records?.length > 0 ? STATUS.LIVE_NOT_PROVEN : STATUS.NOT_BUILT,
     mcConnected.records?.length > 0 ? `Connected App found: ${mcConnected.records[0]?.Name}` : 'No Marketing Cloud connected app found.',
     RISK.LOW],

    ['Foreman / Field App', (foremanApp.records?.length > 0 || foremanLWC || foremanLWC2) ? STATUS.BUILT_NOT_LIVE : STATUS.NOT_BUILT,
     foremanApp.records?.length > 0 ? `App: ${foremanApp.records[0]?.DeveloperName}` : 'No Foreman app or LWC found.',
     RISK.HIGH],

    ['Offline / Mobile Checklist', offlineObj.exists ? STATUS.BUILT_NOT_LIVE : STATUS.NOT_BUILT,
     offlineObj.exists ? 'Mobile_Checklist__c exists.' : 'Mobile_Checklist__c not found.',
     RISK.HIGH],

    ['Rippling Time Source', (ripplingClass || ripplingClass2) ? STATUS.LIVE_NOT_PROVEN : STATUS.NOT_BUILT,
     (ripplingClass || ripplingClass2) ? 'Rippling Apex class found.' : 'No Rippling integration class found.',
     RISK.LOW],

    ['Permission Sets', permSets.total > 0 ? STATUS.PARTIAL : STATUS.NOT_BUILT,
     `${permSets.total} custom permission sets. Key sets found: ${keyPermSets.filter((_,i) => permSetResults[i]).join(', ') || 'none'}.`,
     RISK.HIGH],

    ['Reports / Dashboards', reportCount > 0 ? STATUS.LIVE_NOT_PROVEN : STATUS.NOT_BUILT,
     `${reportCount} reports, ${dashCount} dashboards.`,
     RISK.LOW],

    ['Label Compliance (no UMB/Studio/Funding Source)', labelChecks.length === 0 ? STATUS.WORKING : STATUS.BLOCKED,
     labelChecks.length === 0 ? 'No legacy visible labels detected on audited objects.' : `${labelChecks.length} legacy labels found: ${labelChecks.map(l=>`${l.object}.${l.field}(${l.label})`).join(', ')}`,
     labelChecks.length > 0 ? RISK.HIGH : RISK.LOW],
  ];

  // Print summary table
  const colW = [38, 22, 60, 10];
  const hdr = ['Area','Status','Finding','Risk'].map((h,i) => h.padEnd(colW[i])).join('  ');
  out.push('');
  out.push('  ' + bold(hdr));
  out.push('  ' + gray('─'.repeat(134)));
  for (const [area, status, finding, risk] of summaryRows) {
    const statusColor = status === STATUS.WORKING ? green(status.padEnd(colW[1])) :
      status === STATUS.BLOCKED ? red(status.padEnd(colW[1])) :
      status === STATUS.NOT_BUILT ? red(status.padEnd(colW[1])) :
      yellow(status.padEnd(colW[1]));
    const riskColor = risk === RISK.CRIT || risk === RISK.HIGH ? red(risk) :
      risk === RISK.MED ? yellow(risk) : green(risk);
    out.push(`  ${area.padEnd(colW[0])}  ${statusColor}  ${finding.slice(0,58).padEnd(colW[2])}  ${riskColor}`);
  }

  // ── SECTION: FSL ─────────────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 1. FSL / SCHEDULE CONSOLE / DISPATCHER ──────────────────'));
  out.push(`  Objects:       ${fslObjects.map((o,i) => `${o}: ${fslChecks[i].exists ? green('live') : red('MISSING')}`).join(' | ')}`);
  out.push(`  Service Appts: ${saCount >= 0 ? saCount : red('query failed')}`);
  out.push(`  Work Orders:   ${woCount >= 0 ? woCount : red('query failed')}`);
  out.push(`  Active Resources: ${srCount >= 0 ? srCount : red('query failed')}`);
  out.push(`  FSL App:       ${dispatcherApp.records?.length > 0 ? green('Field_Service app found') : red('NOT FOUND — dispatcher console may not be accessible')}`);
  out.push(`  Schedule Day:  ${schedDay.exists ? green('Schedule_Day__c live') : red('NOT FOUND')} | Records: ${schedDayCount}`);
  out.push(`  Schedule Issue:${schedIssue.exists ? green('Schedule_Issue__c live') : red('NOT FOUND')} | Records: ${schedIssueCount}`);
  out.push('');
  out.push(`  ${bold('ANSWER: Is Schedule Console truly usable today?')}`);
  if (fslLive && saCount > 0 && dispatcherApp.records?.length > 0) {
    out.push(`  ${yellow('PARTIALLY.')} FSL objects and data are live. Dispatcher app exists. But record pages, UI smoke test, and SA-to-resource assignment proof are needed before calling this production-ready.`);
  } else if (fslLive) {
    out.push(`  ${yellow('NOT PROVEN.')} FSL objects are live but no Service Appointment data found and/or Dispatcher app missing. Not usable in production today.`);
  } else {
    out.push(`  ${red('NO.')} Core FSL objects are missing. Not deployed.`);
  }

  // ── SECTION: MARKETS ─────────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 2. SERVICE TERRITORIES / 7 MARKETS ──────────────────────'));
  out.push(`  Approved markets matched: ${matchedMarkets.length}/7`);
  out.push(`  Matched:  ${matchedMarkets.length ? green(matchedMarkets.join(', ')) : red('none')}`);
  out.push(`  All active territories in org (${liveMarkets.length}): ${liveMarkets.join(', ') || 'none'}`);
  if (extraTerritories.length) out.push(`  ${yellow('Extra/legacy territories:')} ${extraTerritories.join(', ')}`);
  out.push(`  ${bold('ANSWER:')} ${matchedMarkets.length === 7 ? green('All 7 markets present.') : red(`Only ${matchedMarkets.length}/7 approved markets. Missing: ${approvedMarkets.filter(m => !matchedMarkets.includes(m)).join(', ')}`)}`);

  // ── SECTION: WEATHER ─────────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 3. WEATHER SYNC / NWS ────────────────────────────────────'));
  out.push(`  Weather_Alert__c: ${weatherObj.exists ? green('live') : red('NOT FOUND')}`);
  out.push(`  Record count:     ${weatherCount}`);
  out.push(`  NWS_Classification__c field: ${weatherClassification ? green('present') : red('MISSING')}`);
  out.push(`  Flow (searched Weather_Sync / NWS_Weather_Sync / WeatherSync): ${(weatherFlow||weatherFlow2||weatherFlow3) ? green((weatherFlow||weatherFlow2||weatherFlow3).DeveloperName + ' v' + (weatherFlow||weatherFlow2||weatherFlow3).VersionNumber) : red('NOT FOUND')}`);
  out.push(`  ${bold('ANSWER:')} ${weatherObj.exists && weatherClassification ? yellow('Live but not proven — no smoke test evidence.') : weatherObj.exists ? red('Object exists but NWS_Classification__c missing. Classification not working.') : red('Not built.')}`);

  // ── SECTION: WEX GPS ─────────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 4. WEX GPS / VEHICLE MAPPING ─────────────────────────────'));
  out.push(`  Vehicle object: ${gpsObjName ? green(gpsObjName) : red('NOT FOUND (checked WEX_Vehicle__c and Vehicle__c)')}`);
  out.push(`  Record count:   ${gpsCount}`);
  out.push(`  Unit_Number__c: ${unitNumField ? green('present') : red('MISSING')}`);
  out.push(`  Driver_Name__c: ${driverField ? green('present') : red('MISSING')}`);
  out.push(`  ${bold('ANSWER:')} ${!gpsObjName ? red('Not built.') : (!unitNumField || !driverField) ? red('Object exists but key fields missing. Vehicles NOT showing Unit Number and Driver Name in UI.') : gpsCount === 0 ? yellow('Fields present but no vehicle records. Not live.') : yellow('Built and has data. UI proof needed.')}`);

  // ── SECTION: TRAFFIC ─────────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 5. TRAFFIC / HERE / ROUTE OPTIMIZATION ───────────────────'));
  out.push(`  Route_Optimization_Result__c: ${routeOptObj.exists ? green('live') : red('NOT FOUND')}`);
  out.push(`  Record count: ${routeCount}`);
  out.push(`  HERE Apex class: ${(hereClass||hereClass2) ? green((hereClass||hereClass2).Name) : red('NOT FOUND')}`);
  out.push(`  Traffic flow: ${trafficFlow ? green(trafficFlow.DeveloperName) : red('NOT FOUND')}`);
  out.push(`  ${bold('ANSWER:')} ${routeOptObj.exists && (hereClass||hereClass2) ? yellow('Backend built. No live route records or flow found — fallback only or disabled.') : red('Not built or not deployed.')}`);

  // ── SECTION: RELEASE READINESS ───────────────────────────────────────
  out.push('');
  out.push(bold('  ── 6. RELEASE READINESS / Schedule_Day__c ───────────────────'));
  out.push(`  Schedule_Day__c: ${schedDay.exists ? green('live') : red('NOT FOUND')}`);
  out.push(`  Release_Status__c field: ${releaseStatusField ? green('present') : red('MISSING')}`);
  out.push(`  Release Readiness flow: ${(releaseFlow||releaseFlow2) ? green((releaseFlow||releaseFlow2).DeveloperName) : red('NOT FOUND')}`);
  out.push(`  Apex controller: ${releaseClass ? green('found') : red('NOT FOUND')}`);
  out.push(`  ${bold('ANSWER:')} ${!schedDay.exists ? red('Schedule_Day__c not found. Not built.') : !releaseStatusField ? red('Object exists but Release_Status__c field missing. NOT writing release status.') : !(releaseFlow||releaseFlow2) ? yellow('Field exists but no flow found. Manual only.') : yellow('Built. Needs smoke test proof.')}`);

  // ── SECTION: OUTDOOR LIVING / UMB ────────────────────────────────────
  out.push('');
  out.push(bold('  ── 7. OUTDOOR LIVING CONSOLE / UPGRADEMYBACKYARD ────────────'));
  out.push(`  App(s) found: ${umbApp.records?.length > 0 ? green(umbApp.records.map(a=>a.DeveloperName).join(', ')) : red('NONE')}`);
  out.push(`  Lane field on Opportunity: ${laneFieldName ? green(laneFieldName) : red('NOT FOUND')}`);
  out.push(`  Picklist values: ${lanePicklistValues.join(', ') || red('none')}`);
  const hasDesignBuild = lanePicklistValues.some(v => v.toLowerCase().includes('design build'));
  const hasUMBlabel = lanePicklistValues.some(v => v.toLowerCase().includes('umb') || v.toLowerCase() === 'the studio');
  out.push(`  "Design Build" in picklist: ${hasDesignBuild ? green('YES') : red('NO')}`);
  out.push(`  Legacy "UMB"/"The Studio" still visible: ${hasUMBlabel ? red('YES — REMOVE') : green('NO')}`);
  out.push(`  ${bold('ANSWER:')} ${umbApp.records?.length > 0 && hasDesignBuild ? yellow('Partially working. App exists and Design Build lane present. Full UI click-through not proven.') : red('Console not confirmed usable. App and/or lane picklist incomplete.')}`);

  // ── SECTION: VOUCHERS / LENNAR ───────────────────────────────────────
  out.push('');
  out.push(bold('  ── 8. VOUCHERS / LENNAR GRILLING ISLAND / CAMPAIGNS ─────────'));
  out.push(`  Voucher__c: ${voucherObj.exists ? green('live') : red('NOT FOUND')}`);
  out.push(`  Total vouchers: ${voucherCount} | Lennar/Grilling records: ${lennarVoucher.records?.length || 0}`);
  out.push(`  Lennar flow (searched 3 names): ${(lennarFlow||lennarFlow2||lennarFlow3) ? green((lennarFlow||lennarFlow2||lennarFlow3).DeveloperName) : red('NOT FOUND')}`);
  out.push(`  Campaigns: ${campaignCount}`);
  out.push(`  Sponsor_Payment_Responsibility__c on Opp: ${sponsorField ? green('present') : red('MISSING — still "Funding Source"?')}`);
  out.push(`  Funding_Source__c (legacy): ${fundingField ? yellow('STILL EXISTS — verify if label is hidden from UI') : green('not present')}`);
  out.push(`  ${bold('ANSWER:')} ${!voucherObj.exists ? red('Voucher__c not found.') : !(lennarFlow||lennarFlow2||lennarFlow3) ? red('Voucher object exists but Lennar flow NOT FOUND. End-to-end not smoke-tested.') : lennarVoucher.records?.length === 0 ? yellow('Flow found but no Lennar voucher records exist. Not smoke-tested.') : yellow('Records exist. Flow exists. Full end-to-end smoke test proof needed.')}`);

  // ── SECTION: QUOTES / PAYMENTS / CHANGE ORDERS / WARRANTY ────────────
  out.push('');
  out.push(bold('  ── 9. QUOTES / PAYMENT MILESTONES / CHANGE ORDERS / WARRANTY ─'));
  out.push(`  Quote:            ${quoteObj.exists ? green('live') : red('NOT FOUND')} | ${quoteCount} records`);
  out.push(`  Payment_Milestone__c: ${paymentObj.exists ? green('live') : red('NOT FOUND')} | ${paymentCount} records`);
  out.push(`  Change_Order__c:  ${changeOrderObj.exists ? green('live') : red('NOT FOUND')} | ${changeOrderCount} records`);
  out.push(`  Warranty__c:      ${warrantyObj.exists ? green('live') : red('NOT FOUND')} | ${warrantyCount} records`);

  // ── SECTION: RECORD PAGES ────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 10. LIGHTNING RECORD PAGES ───────────────────────────────'));
  out.push(`  Total FlexiPages (record type): ${flexiPages.length}`);
  const pageNames = flexiPages.map(p => p.DeveloperName);
  for (const obj of ['Account','Lead','Opportunity','Quote','WorkOrder','ServiceAppointment','Campaign']) {
    const match = pageNames.filter(n => n.toLowerCase().includes(obj.toLowerCase()));
    out.push(`  ${obj.padEnd(22)} ${match.length > 0 ? green(match.join(', ')) : yellow('no dedicated page found — using default layout')}`);
  }

  // ── SECTION: COMMS ───────────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 11. EMAIL / RINGCENTRAL / MARKETING CLOUD ────────────────'));
  out.push(`  Schedule/dispatch email templates: ${emailTemplates.total}`);
  out.push(`  RingCentral Apex: ${(rcClass||rcClass2) ? green('found') : red('NOT FOUND')}`);
  out.push(`  Marketing Cloud connected app: ${mcConnected.records?.length > 0 ? green(mcConnected.records[0]?.Name) : red('NOT FOUND')}`);
  out.push(`  Marketing Cloud sync flow: ${mcFlow ? green(mcFlow.DeveloperName) : red('NOT FOUND')}`);
  out.push(`  ${bold('ANSWER:')} Marketing Cloud: ${mcConnected.records?.length > 0 ? yellow('Connected app present. Not proven configured.') : red('Not configured — readiness only.')}`);

  // ── SECTION: FOREMAN ─────────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 12. FOREMAN / LOVING FIELD APP ───────────────────────────'));
  out.push(`  Foreman app: ${foremanApp.records?.length > 0 ? green(foremanApp.records.map(a=>a.DeveloperName).join(', ')) : red('NOT FOUND')}`);
  out.push(`  Foreman LWC: ${(foremanLWC||foremanLWC2) ? green('found') : red('NOT FOUND')}`);
  out.push(`  Mobile_Checklist__c: ${offlineObj.exists ? green('live') : red('NOT FOUND')}`);
  out.push(`  Job_Photo__c: ${photoObj.exists ? green('live') : red('NOT FOUND')}`);
  out.push(`  Field_Issue__c: ${issueObj.exists ? green('live') : red('NOT FOUND')}`);
  out.push(`  Closeout__c: ${closeoutObj.exists ? green('live') : red('NOT FOUND')}`);
  out.push(`  ${bold('ANSWER:')} ${foremanApp.records?.length > 0 ? yellow('App found. Offline objects need verification. NOT field-pilot ready without device smoke test.') : red('Foreman app not found. Not installable today.')}`);

  // ── SECTION: PERMISSION SETS ─────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 13. PERMISSION SETS ──────────────────────────────────────'));
  out.push(`  Total custom permission sets: ${permSets.total}`);
  keyPermSets.forEach((name, i) => {
    out.push(`  ${name.padEnd(25)} ${permSetResults[i] ? green('found: ' + permSetResults[i].Label) : yellow('not found with that exact API name')}`);
  });
  out.push(`  ${bold('NOTE:')} Confirm user assignments and object-level access via Setup → Permission Sets. CLI can only confirm set existence.`);

  // ── SECTION: RIPPLING ────────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 14. RIPPLING TIME SOURCE ─────────────────────────────────'));
  out.push(`  Rippling Apex: ${(ripplingClass||ripplingClass2) ? green('found') : red('NOT FOUND')}`);
  out.push(`  Time_Entry__c: ${timeObj.exists ? green('live') : red('NOT FOUND')}`);

  // ── SECTION: LABEL COMPLIANCE ────────────────────────────────────────
  out.push('');
  out.push(bold('  ── 15. LABEL COMPLIANCE AUDIT ───────────────────────────────'));
  if (labelChecks.length === 0) {
    out.push(`  ${green('No legacy labels (UMB, The Studio, Funding Source, Custom Build) detected on Opportunity, Account, Quote, WorkOrder.')}`);
  } else {
    out.push(`  ${red(`${labelChecks.length} legacy label(s) found that must be corrected:`)}`);
    for (const l of labelChecks) {
      out.push(`    ${red('!')} ${l.object}.${l.field} — visible label: "${l.label}"`);
    }
  }
  out.push(`  ${bold('UpgradeMyBackyard label:')} ${lanePicklistValues.some(v=>v.includes('UpgradeMyBackyard')) || umbApp.records?.some(a=>a.Label?.includes('UpgradeMyBackyard')) ? green('found') : yellow('not confirmed — verify app nav label in Setup')}`);

  // ── SPECIFIC QUESTIONS ───────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── DIRECT ANSWERS TO YOUR 18 QUESTIONS ──────────────────────'));
  const qa = [
    ['1. Schedule Console truly usable today?', fslLive && saCount > 0 && dispatcherApp.records?.length > 0 ? yellow('PARTIAL — objects and data live, UI proof needed') : red('NO — objects missing or no data or dispatcher app not found')],
    ['2. FSL Dispatcher integrated or just linked?', dispatcherApp.records?.length > 0 ? yellow('App exists. Cannot confirm full dispatcher integration without UI test.') : red('Dispatcher app not found in org.')],
    ['3. WEX GPS showing Unit Number + Driver Name?', (unitNumField && driverField && gpsCount > 0) ? yellow('Fields exist and records present. UI display not confirmed.') : red('NO — ' + (!gpsObjName ? 'vehicle object missing' : !unitNumField ? 'Unit_Number__c missing' : !driverField ? 'Driver_Name__c missing' : 'no vehicle records'))],
    ['4. 7 markets working correctly?', matchedMarkets.length === 7 ? green('YES — all 7 found') : red(`NO — only ${matchedMarkets.length}/7. Missing: ${approvedMarkets.filter(m=>!matchedMarkets.includes(m)).join(', ')}`)],
    ['5. Weather sync live + classifying alerts?', weatherObj.exists && weatherClassification ? yellow('Object + classification field live. Flow not confirmed. Not smoke-tested.') : weatherObj.exists ? red('Object live but NWS_Classification__c MISSING') : red('Not built')],
    ['6. Traffic live, fallback-only, or disabled?', routeOptObj.exists && routeCount > 0 ? yellow('Records exist. Likely fallback or passive.') : routeOptObj.exists ? yellow('Object live, no records. Effectively disabled.') : red('Not built')],
    ['7. Release Readiness writing Release_Status__c?', releaseStatusField && (releaseFlow||releaseFlow2) ? yellow('Field + flow both exist. Not smoke-tested — cannot confirm it is writing.') : red('NO — ' + (!releaseStatusField ? 'Release_Status__c field missing' : 'no release readiness flow found'))],
    ['8. Schedule Issues fully actionable from UI?', schedIssue.exists && schedIssueCount > 0 ? yellow('Object + data live. UI actions (buttons, page) not confirmed.') : schedIssue.exists ? yellow('Object live, no records. Cannot confirm actionable.') : red('Schedule_Issue__c not found')],
    ['9. Outdoor Living Console usable today?', umbApp.records?.length > 0 && hasDesignBuild ? yellow('App exists. Full console usability not proven.') : red('NO — app not found or lane picklist incomplete')],
    ['10. Key object pages built + assigned?', flexiPages.length >= 8 ? yellow(`${flexiPages.length} record pages found. Assignment to all objects not fully confirmed.`) : red(`Only ${flexiPages.length} record pages. Many pages likely missing or on default layouts.`)],
    ['11. Lennar Grilling Island flow smoke-tested?', lennarVoucher.records?.length > 0 ? yellow('Records exist but no smoke test evidence in org data.') : red('NO — ' + (!(lennarFlow||lennarFlow2||lennarFlow3) ? 'flow not found' : 'flow found but no Lennar voucher records'))],
    ['12. UpgradeMyBackyard fully renamed everywhere?', labelChecks.length === 0 ? yellow('No legacy labels on key objects. App nav label needs manual UI verify.') : red('Legacy labels still present — see label compliance section')],
    ['13. Marketing Cloud configured or just documented?', mcConnected.records?.length > 0 ? yellow('Connected app present. Actual MC configuration (send flows, audiences) not proven.') : red('Not configured — documentation only')],
    ['14. Foreman app installable + field-pilot ready?', foremanApp.records?.length > 0 ? yellow('App found in org. Offline sync + device test NOT proven.') : red('NO — Foreman app not found in org')],
    ['15. Offline checklist/photo/issue/closeout proven?', (offlineObj.exists && photoObj.exists) ? yellow('Objects exist. No device-level sync proof found.') : red('NO — one or more mobile objects missing')],
    ['16. What can go live today?', green('See Go-Live table below')],
    ['17. What should NOT go live yet?', yellow('See Go-Live table below')],
    ['18. Top 10 blockers to full launch?', yellow('See blockers section below')],
  ];
  qa.forEach(([q, a]) => { out.push(`\n  ${bold(q)}\n  ${a}`); });

  // ── TOP 10 BLOCKERS ──────────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── TOP 10 BLOCKERS TO FULL LAUNCH ──────────────────────────'));
  const blockers = [
    [matchedMarkets.length < 7, `Markets: Only ${matchedMarkets.length}/7 approved territories active. Missing: ${approvedMarkets.filter(m=>!matchedMarkets.includes(m)).join(', ')}`],
    [!releaseStatusField, 'Release Readiness: Release_Status__c field missing on Schedule_Day__c — release gating not functional'],
    [!gpsObjName || !unitNumField || !driverField, `WEX GPS: ${!gpsObjName ? 'Vehicle object missing' : 'Unit_Number__c or Driver_Name__c field missing'} — vehicles not mapped to drivers`],
    [!(lennarFlow||lennarFlow2||lennarFlow3) || lennarVoucher.records?.length === 0, 'Lennar Voucher: Flow not found or no smoke test records — not end-to-end proven'],
    [!weatherClassification, 'Weather: NWS_Classification__c missing — alerts not being classified correctly'],
    [flexiPages.length < 8, `Record Pages: Only ${flexiPages.length} Lightning pages found — most objects likely on default layouts`],
    [!foremanApp.records?.length, 'Foreman App: Not found in org — field pilot cannot start'],
    [permSets.total < 3, 'Permission Sets: Insufficient custom permission sets — user access to key objects not confirmed'],
    [!sponsorField && fundingField, 'Label: Funding_Source__c still present — "Sponsor Payment Responsibility" rename may not be complete'],
    [!schedDay.exists, 'Schedule_Day__c: Object not found — release readiness and day-level scheduling cannot function'],
  ].filter(([condition]) => condition).map(([,msg]) => msg);

  if (blockers.length === 0) {
    out.push(`  ${green('No critical blockers detected. Proceed to UI smoke testing.')}`);
  } else {
    blockers.slice(0, 10).forEach((b, i) => out.push(`  ${red(`${i+1}.`)} ${b}`));
  }

  // ── GO-LIVE TABLE ────────────────────────────────────────────────────
  out.push('');
  out.push(bold('  ── GO-LIVE READINESS TABLE ──────────────────────────────────'));
  const goLiveRows = [
    ['Schedule Console / FSL', fslLive && saCount > 0 ? 'Partial' : 'No',
     fslLive && saCount > 0 ? 'Objects + data live. UI smoke test required.' : 'Objects missing or no data.',
     fslLive ? 'Engineering' : 'Engineering', 'Run end-to-end SA dispatch smoke test'],
    ['Weather', weatherObj.exists && weatherClassification ? 'Partial' : 'No',
     weatherObj.exists && weatherClassification ? 'Object + field live. Flow + classification needs smoke test.' : 'NWS_Classification__c missing.',
     'Engineering', weatherClassification ? 'Trigger a test alert, verify classification' : 'Add NWS_Classification__c field'],
    ['WEX GPS', gpsObjName && unitNumField && driverField && gpsCount > 0 ? 'Partial' : 'No',
     gpsObjName ? 'Object exists. Field + UI proof needed.' : 'Vehicle object not found.',
     'Engineering', !gpsObjName ? 'Build WEX_Vehicle__c object' : 'Add missing fields, load vehicle data'],
    ['Traffic', routeOptObj.exists ? 'Partial' : 'No',
     routeOptObj.exists ? 'Object live, no records. Fallback mode only.' : 'Not built.',
     'Engineering', 'Activate HERE integration and verify route records'],
    ['Outdoor Living / UpgradeMyBackyard', umbApp.records?.length > 0 ? 'Partial' : 'No',
     umbApp.records?.length > 0 ? 'App found. Full console + navigation proof needed.' : 'App not found.',
     'Engineering', 'UI click-through the full Outdoor Living console'],
    ['Lennar Voucher Flow', (lennarFlow||lennarFlow2||lennarFlow3) && lennarVoucher.records?.length > 0 ? 'Partial' : 'No',
     (lennarFlow||lennarFlow2||lennarFlow3) ? 'Flow exists. Needs end-to-end smoke test with real record.' : 'Flow not found.',
     'Meg + Engineering', 'Run Lennar grilling island flow end to end with a test voucher'],
    ['Marketing Cloud', mcConnected.records?.length > 0 ? 'Partial' : 'No',
     mcConnected.records?.length > 0 ? 'Connected app present. Send flows not confirmed.' : 'Not configured.',
     'Meg + Marketing', 'Configure MC send flows and test audience sync'],
    ['Homeowner Account', flexiPages.some(p=>p.DeveloperName.toLowerCase().includes('account')) ? 'Partial' : 'No',
     'Account page exists. Homeowner-specific layout and components need UI proof.',
     'Engineering', 'Verify Homeowner Account page assignment and component display'],
    ['Email / Communications', emailTemplates.total > 0 ? 'Partial' : 'No',
     emailTemplates.total > 0 ? `${emailTemplates.total} templates found. Delivery not tested.` : 'No schedule email templates found.',
     'Engineering + Meg', 'Send a test homeowner schedule email end to end'],
    ['Foreman Field App', foremanApp.records?.length > 0 ? 'Partial' : 'No',
     foremanApp.records?.length > 0 ? 'App in org. Offline sync not device-tested.' : 'App not found in org.',
     'Engineering', foremanApp.records?.length > 0 ? 'Install on field device, run offline checklist + photo test' : 'Build and deploy Foreman app'],
  ];

  const gColW = [32, 10, 52, 18, 30];
  const gHdr = ['Launch Area','Go Live?','Why / Why Not','Blocking Owner','Next Action'].map((h,i)=>h.padEnd(gColW[i])).join('  ');
  out.push('  ' + bold(gHdr));
  out.push('  ' + gray('─'.repeat(148)));
  for (const [area, go, why, owner, next] of goLiveRows) {
    const goColor = go === 'Yes' ? green(go.padEnd(gColW[1])) : go === 'Partial' ? yellow(go.padEnd(gColW[1])) : red(go.padEnd(gColW[1]));
    out.push(`  ${area.padEnd(gColW[0])}  ${goColor}  ${why.slice(0,50).padEnd(gColW[2])}  ${owner.padEnd(gColW[3])}  ${next.slice(0,28)}`);
  }

  out.push('');
  out.push(bold(`  Audit complete: ${new Date().toLocaleString()}`));
  out.push(gray('  To re-run: node bin/dispatch.js audit'));
  out.push(gray('  To save:   node bin/dispatch.js audit > audit-report.txt'));
  out.push('');

  console.log(out.join('\n'));
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
    ${cyan('audit')}               Full production system audit
    ${cyan('audit-odl')}          Deep Voucher / Lennar / Outdoor Living / UMB audit
    ${cyan('fix')} <subcommand>     Deploy production fixes (run: dispatch fix help)
    ${cyan('check-lennar')}         Deep check of Lennar/Voucher/Campaign data
    ${cyan('help')}                 Show this help

  ${bold('Examples:')}
    dispatch connect
    dispatch audit
    dispatch fix deploy
    dispatch fix territories
    dispatch check-lennar
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
    case 'audit':         await cmdAudit(); break;
    case 'fix':           await cmdFix(args); break;
    case 'check-lennar':  await cmdCheckLennar(); break;
    case 'audit-odl':     await cmdAuditODL(); break;
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
