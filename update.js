#!/usr/bin/env node
'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const IG_CH  = new Set(['Draft Orders', 'IG Live Sales', 'Sugar Live Invoicer', 'Facebook & Instagram']);
const WEB_CH = new Set(['Online Store', 'Shop']);
const IP_CH  = new Set(['Point of Sale', 'Shopify Mobile for iPhone']);

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

async function parseJSONL(filePath) {
  const out = {};
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const { month, sales_channel, net_sales } = JSON.parse(line);
    const m = month.slice(0, 7);
    if (!out[m]) out[m] = { ig: 0, web: 0, ip: 0 };
    const amt = Math.round(net_sales);
    if (IG_CH.has(sales_channel))       out[m].ig  += amt;
    else if (WEB_CH.has(sales_channel)) out[m].web += amt;
    else if (IP_CH.has(sales_channel))  out[m].ip  += amt;
  }
  return out;
}

function fmtObj(obj) {
  const entries = Object.entries(obj);
  if (!entries.length) return '{}';
  return '{' + entries.map(([k, v]) => `'${k}':${v}`).join(',') + '}';
}

async function main() {
  const root       = __dirname;
  const shopifyDir = path.join(root, 'data', 'shopify');
  const wwagFile   = path.join(root, 'data', 'wwag.json');
  const htmlFile   = path.join(root, 'index.html');

  // --- Shopify JSONL ---
  const files = fs.readdirSync(shopifyDir).filter(f => f.endsWith('.jsonl'));
  if (!files.length) { console.error('No .jsonl files found in data/shopify/'); process.exit(1); }

  const shopify = {};
  for (const f of files) {
    const parsed = await parseJSONL(path.join(shopifyDir, f));
    for (const [m, v] of Object.entries(parsed)) {
      if (!shopify[m]) shopify[m] = { ig: 0, web: 0, ip: 0 };
      shopify[m].ig  += v.ig;
      shopify[m].web += v.web;
      shopify[m].ip  += v.ip;
    }
  }
  console.log(`Loaded ${files.length} Shopify file(s), ${Object.keys(shopify).length} months`);

  // --- WWAG ---
  let wwag = {};
  if (fs.existsSync(wwagFile)) {
    wwag = JSON.parse(fs.readFileSync(wwagFile, 'utf8'));
    console.log(`Loaded WWAG data: ${Object.keys(wwag).length} months`);
  } else {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const m = html.match(/const wwag\s*=\s*(\{[^;]+\})/);
    if (m) {
      try {
        wwag = JSON.parse(m[1].replace(/'/g, '"').replace(/([0-9]{4}-[0-9]{2}):/g, '"$1":'));
        console.log('Using existing wwag from index.html (place data/wwag.json to override)');
      } catch { console.warn('Could not parse existing wwag — leaving empty'); }
    }
  }

  // --- Build month list & data objects ---
  const allMonths = [...new Set([...Object.keys(shopify), ...Object.keys(wwag)])].sort();
  const dataIG = {}, dataWeb = {}, dataIP = {};
  for (const m of allMonths) {
    if (shopify[m]?.ig)  dataIG[m]  = shopify[m].ig;
    if (shopify[m]?.web) dataWeb[m] = shopify[m].web;
    if (shopify[m]?.ip)  dataIP[m]  = shopify[m].ip;
  }

  // --- Write data block ---
  const block = [
    '// BEGIN_DATA — updated by: node update.js',
    `const ALL_MONTHS=${JSON.stringify(allMonths)};`,
    `const dataIG  =${fmtObj(dataIG)};`,
    `const dataWeb =${fmtObj(dataWeb)};`,
    `const dataIP  =${fmtObj(dataIP)};`,
    `const wwag    =${fmtObj(wwag)};`,
    '// END_DATA',
  ].join('\n');

  let html = fs.readFileSync(htmlFile, 'utf8');
  if (!html.includes('// BEGIN_DATA')) { console.error('// BEGIN_DATA marker not found in index.html'); process.exit(1); }
  html = html.replace(/\/\/ BEGIN_DATA[\s\S]*?\/\/ END_DATA/, block);

  // --- Update topbar date range ---
  const first = allMonths[0], last = allMonths[allMonths.length - 1];
  const [fy, fm] = first.split('-'), [ly, lm] = last.split('-');
  const range = `${MONTHS[+fm-1]} ${fy} \u2013 ${MONTHS[+lm-1]} ${ly}`;
  html = html.replace(/(Instagram \u00b7 Website \u00b7 In-person \u00b7 WWAG.*?\u00b7\s*)([A-Z][a-z]+ \d{4} \u2013 [A-Z][a-z]+ \d{4})/, `$1${range}`);

  fs.writeFileSync(htmlFile, html);
  console.log(`✓ ${allMonths.length} months: ${first} → ${last} (${range})`);
  console.log('Next: git add index.html && git commit -m "Update data" && git push');
}

main().catch(e => { console.error(e); process.exit(1); });
