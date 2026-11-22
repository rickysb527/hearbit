#!/usr/bin/env node
/* バージョン・SWプリキャッシュの整合検証（デプロイ前に実行）。
 *
 * 確認項目:
 *   1) js/version.js の APP_VERSION と sw.js の VERSION が一致する
 *      （ずれると「更新があります」が出続ける／出ない）。
 *   2) sw.js の ASSETS が全て実在する（欠けると install が失敗し更新が届かない）。
 *   3) index.html が読み込む js/css が全て ASSETS に入っている（オフライン起動に必要）。
 *
 * 使い方: node app/verify/verify_version.js
 */
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const { APP_VERSION } = require('../js/version.js');
const sw = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');

let fails = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
}

const m = sw.match(/const VERSION = (\d+);/);
const swVersion = m ? Number(m[1]) : null;
check('APP_VERSION と sw.js VERSION が一致', swVersion === APP_VERSION, `app=${APP_VERSION} sw=${swVersion}`);

const assetsSrc = sw.match(/const ASSETS = \[([\s\S]*?)\];/);
const assets = assetsSrc ? [...assetsSrc[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
const missing = assets.filter((a) => a !== './' && !fs.existsSync(path.join(APP, a)));
check('ASSETS が全て実在する', assets.length > 0 && missing.length === 0, missing.join(', '));

const refs = [...html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)].map((x) => './' + x[1]);
const notCached = refs.filter((r) => !assets.includes(r));
check('index.html の js/css が全て ASSETS に入っている', notCached.length === 0, notCached.join(', '));

console.log(fails ? `\n${fails} 件 FAIL` : '\nALL PASS');
process.exit(fails ? 1 : 0);
