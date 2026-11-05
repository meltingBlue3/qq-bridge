#!/usr/bin/env node
// No production config, environment credentials or DSH home are read.
import fs from 'node:fs';
import { createDefaultConfig } from '../src/config-defaults.js';
import { atomicWriteText } from '../src/json-file.js';

const file = new URL('../config.example.json', import.meta.url);
const expected = `${JSON.stringify(createDefaultConfig(), null, 2)}\n`;
const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
if (process.argv.includes('--check')) {
  if (actual.replace(/\r\n/g, '\n') !== expected) {
    console.error('config.example.json 已过期，请运行 node scripts/build-config-example.mjs');
    process.exitCode = 1;
  } else console.log('config.example.json 与默认值一致');
} else {
  const { fileURLToPath } = await import('node:url');
  if (actual.replace(/\r\n/g, '\n') !== expected) atomicWriteText(fileURLToPath(file), expected);
  console.log('config.example.json 已按默认值生成');
}
