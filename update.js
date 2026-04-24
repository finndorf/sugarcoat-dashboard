#!/usr/bin/env node
'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const IG_CH  = new Set(['Draft Orders', 'IG Live Sales', 'Sugar Live Invoicer', 'Facebook & Instagram']);
const WEB_CH = new Set(['Online Store', 'Shop']);
const IP_CH  = new Set(['Point of Sale', 'Shopify Mobile for iPhone']);

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const MONTH_NAME = {
  January:1, February:2, March:3, April:4, May:5, June:6,
  July:7, August:8, September:9, October:10, November:11, December:12,
};

// Minimal CSV line parser that handles double-quoted fields
function parseCSVLine(line) {
  const cols = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { cols.push(cur); cur = ''; }
    else { cur += c; }
  }
  cols.push(cur);
  return cols;
}

// "June 04, 2025" → "2025-06"
function parsePalomaDate(str) {
  const parts = str.trim().split(' ');
  const m = MONTH_NAME[parts[0]];
  const yr = parts[2];
  if (!m || !yr) return null;
  return `${yr}-${String(m).padStart(2, '0')}`;
}

function parsePaloma(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.csv'));
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    const header = parseCSVLine(lines[0].replace(/^﻿/, ''));
    const orderNumIdx = header.indexOf('Order number');
    const paidAtIdx   = header.indexOf('Paid at');
    const netIdx      = header.indexOf('Net');
    const seen = new Set();
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const cols = parseCSVLine(line);
      const orderNum = cols[orderNumIdx];
      if (!orderNum || seen.has(orderNum)) continue;
      seen.add(orderNum);
      const month = parsePalomaDate(cols[paidAtIdx] || '');
      if (!month) continue;
      const net = parseFloat(cols[netIdx]);
      if (!isNaN(net)) out[month] = (out[month] || 0) + net;
    }
  }
  for (const m of Object.keys(out)) out[m] = Math.round(out[m]);
  if (files.length) console.log(`Loaded ${files.length} Paloma file(s), ${Object.keys(out).length} months`);
  return out;
}

function parseSquare(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.csv'));
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    const header = parseCSVLine(lines[0].replace(/^﻿/, ''));
    const dateIdx     = header.indexOf('Date');
    const netSalesIdx = header.indexOf('Net Sales');
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const cols  = parseCSVLine(line);
      const date  = cols[dateIdx] || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const month = date.slice(0, 7);
      const net   = parseFloat((cols[netSalesIdx] || '').replace(/[$,]/g, ''));
      if (!isNaN(net)) out[month] = (out[month] || 0) + net;
    }
  }
  for (const m of Object.keys(out)) out[m] = Math.round(out[m]);
  if (files.length) console.log(`Loaded ${files.length} Square file(s), ${Object.keys(out).length} months`);
  return out;
}

function parseQuickBooks(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.csv'));
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    const headerIdx = lines.findIndex(l => l.includes('Transaction date'));
    if (headerIdx === -1) continue;
    const header = parseCSVLine(lines[headerIdx]);
    const dateIdx = header.indexOf('Transaction date');
    const amtIdx  = header.indexOf('Amount');
    for (const line of lines.slice(headerIdx + 1)) {
      if (!line.trim()) continue;
      const cols = parseCSVLine(line);
      const date = (cols[dateIdx] || '').trim();
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) continue;
      const [mo, , yr] = date.split('/');
      const month = `${yr}-${mo}`;
      const amt = parseFloat((cols[amtIdx] || '').replace(/[$,]/g, ''));
      if (!isNaN(amt)) out[month] = (out[month] || 0) + amt;
    }
  }
  for (const m of Object.keys(out)) out[m] = Math.round(out[m]);
  if (files.length) console.log(`Loaded ${files.length} QuickBooks file(s), ${Object.keys(out).length} months`);
  return out;
}

async function parseJSONL(filePath) {
  const out = {};
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const { month, hour, sales_channel, net_sales } = JSON.parse(line);
    const m = (month || hour).slice(0, 7);
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
  const palomaDir  = path.join(root, 'data', 'paloma');
  const squareDir  = path.join(root, 'data', 'square');
  const qbDir      = path.join(root, 'data', 'quickbooks');

  // --- Shopify JSONL ---
  const files = fs.readdirSync(shopifyDir).filter(f => f.endsWith('.jsonl'));
  if (!files.length) console.warn('No .jsonl files found in data/shopify/ — skipping Shopify');

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
  if (files.length) console.log(`Loaded ${files.length} Shopify file(s), ${Object.keys(shopify).length} months`);

  // --- WWAG ---
  // Extract existing wwag from index.html as baseline
  let wwag = {};
  const existingHtml = fs.readFileSync(htmlFile, 'utf8');
  const wwagMatch = existingHtml.match(/const wwag\s*=\s*(\{[^;]+\})/);
  if (wwagMatch) {
    try { wwag = JSON.parse(wwagMatch[1].replace(/'/g,'"').replace(/([0-9]{4}-[0-9]{2}):/g,'"$1":')); } catch {}
  }

  // Override/merge with data/wwag.json if present
  if (fs.existsSync(wwagFile)) {
    const override = JSON.parse(fs.readFileSync(wwagFile, 'utf8'));
    Object.assign(wwag, override);
    console.log(`Merged WWAG from wwag.json: ${Object.keys(override).length} months`);
  }

  // Parse any Mall-Central CSVs in data/wwag/
  const wwagDir = path.join(root, 'data', 'wwag');
  if (fs.existsSync(wwagDir)) {
    const csvFiles = fs.readdirSync(wwagDir).filter(f => f.endsWith('.csv'));
    for (const f of csvFiles) {
      const lines = fs.readFileSync(path.join(wwagDir, f), 'utf8').split('\n');
      for (const line of lines.slice(1)) {
        const cols = line.split(',').map(c => c.replace(/"/g,'').trim());
        const date = cols[0];
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) continue;
        const [mo,,yr] = date.split('/');
        const month = yr + '-' + mo;
        const amt = parseFloat(cols[8]);
        if (isNaN(amt)) continue;
        wwag[month] = (wwag[month] || 0) + amt;
      }
    }
    if (csvFiles.length) {
      // Round all values after summing
      for (const m of Object.keys(wwag)) wwag[m] = Math.round(wwag[m]);
      console.log(`Parsed ${csvFiles.length} WWAG CSV file(s)`);
    }
  }

  // --- Paloma (→ IG), Square (→ IP), QuickBooks (→ IP) ---
  const paloma = parsePaloma(palomaDir);
  const square = parseSquare(squareDir);
  const qb     = parseQuickBooks(qbDir);

  // --- Build month list & data objects ---
  const allMonths = [...new Set([
    ...Object.keys(shopify), ...Object.keys(wwag),
    ...Object.keys(paloma),  ...Object.keys(square), ...Object.keys(qb),
  ])].sort();
  const dataIG = {}, dataWeb = {}, dataIP = {};
  for (const m of allMonths) {
    const ig = (shopify[m]?.ig || 0) + (paloma[m] || 0);
    if (ig)              dataIG[m]  = ig;
    if (shopify[m]?.web) dataWeb[m] = shopify[m].web;
    const ip = (shopify[m]?.ip || 0) + (square[m] || 0) + (qb[m] || 0);
    if (ip)              dataIP[m]  = ip;
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
