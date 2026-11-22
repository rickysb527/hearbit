#!/usr/bin/env node
/* 聞き流し（listen.js）の AudioContext 状態ハンドリング検証。
 *
 * iOS Safari で AudioContext が suspended / interrupted のまま残ると、
 * 「⏸表示なのに無音・リング停止」になる実機バグがあった。その修正の状態遷移を、
 * モックの AudioContext を入れた vm 上で実コード（listen.js）を動かして確認する。
 *
 * 確認項目:
 *   A) running: そのまま source.start され再生中になる。
 *   B) suspended → resume 成功: running になってから再生。
 *   C) interrupted → resume が解決しない（iOS）: 再生せず一時停止状態 + onNotice('blocked')。
 *   D) C の後 ▶（toggle）で resume が通る: 再生開始。
 *   E) 再生中に interrupted へ遷移: UI が一時停止に合わせられる。
 *   F) トラック構築失敗: onNotice('build-failed', err)。
 *   G) ensureRunning 待機中に stop: 待機明けに鳴り出さない。
 *
 * 使い方: node app/verify/verify_listen_resume.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ListenBuild = require('../js/listen-build.js');

const SRC = fs.readFileSync(path.join(__dirname, '../js/listen.js'), 'utf8') + '\n;this.Listen = Listen;';

// resumeMode: 'ok'（running にして解決）| 'hang'（解決しない・状態不変）| 'reject'
function makeEnv({ initialState = 'running', resumeMode = 'ok', decodeFails = false } = {}) {
  const log = { started: 0, notices: [], playing: [] };
  let ctxRef = null;
  class FakeCtx {
    constructor() {
      this.state = initialState; this.sampleRate = 8000; this.currentTime = 0;
      this.destination = {}; this.resumeMode = resumeMode; ctxRef = this;
    }
    resume() {
      if (this.resumeMode === 'ok') { this.setState('running'); return Promise.resolve(); }
      if (this.resumeMode === 'reject') return Promise.reject(new Error('NotAllowedError'));
      return new Promise(() => {}); // hang
    }
    setState(s) { this.state = s; if (this.onstatechange) this.onstatechange(); }
    createBuffer(ch, len, sr) {
      const d = new Float32Array(len);
      return { length: len, duration: len / sr, getChannelData: () => d };
    }
    decodeAudioData(arr, res, rej) {
      if (decodeFails) { rej(new Error('EncodingError')); return; }
      const d = new Float32Array(8000 * 10);
      res({ sampleRate: 8000, length: d.length, numberOfChannels: 1, getChannelData: () => d });
    }
    createBufferSource() {
      return { connect() {}, disconnect() {}, stop() {}, start() { log.started++; } };
    }
    createGain() { return { connect() {} }; }
  }
  const sandbox = {
    window: { AudioContext: FakeCtx },
    navigator: {},
    ListenBuild,
    Splitter: { detectSilences: () => [] },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    setTimeout, console: { warn() {}, log: console.log },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const Listen = sandbox.Listen;
  const words = [0, 1, 2].map((i) => ({
    page: '001', seg: { index: i, start: i * 3, end: i * 3 + 2, type: 'word' },
  }));
  Listen.configure({
    bookName: 'test', words,
    getBlobFor: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
    ui: {
      onPlaying: (p) => log.playing.push(p),
      onNotice: (kind, err) => log.notices.push(err ? `${kind}:${err.message}` : kind),
    },
  });
  return { Listen, log, ctx: () => ctxRef };
}

let fails = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) fails++;
}

(async () => {
  { // A
    const { Listen, log } = makeEnv({ initialState: 'running' });
    await Listen.playRange(0, 3, 50);
    check('A running: 再生開始', log.started === 1 && Listen.isPlaying() && log.notices.length === 0);
  }
  { // B
    const { Listen, log, ctx } = makeEnv({ initialState: 'suspended', resumeMode: 'ok' });
    await Listen.playRange(0, 3, 50);
    check('B suspended→resume成功: running で再生', ctx().state === 'running' && log.started === 1 && Listen.isPlaying());
  }
  { // C, D
    const { Listen, log, ctx } = makeEnv({ initialState: 'interrupted', resumeMode: 'hang' });
    const t0 = Date.now();
    await Listen.playRange(0, 3, 50);
    check('C interrupted+resume解決せず: 鳴らさず一時停止 + blocked 通知',
      log.started === 0 && !Listen.isPlaying() && Listen.isActive() &&
      log.notices.includes('blocked') && log.playing[log.playing.length - 1] === false);
    check('C タイムアウトで打ち切り（固まらない）', Date.now() - t0 < 5000);
    ctx().resumeMode = 'ok'; // ▶タップ = ユーザー操作で resume が通る
    Listen.toggle();
    await new Promise((r) => setTimeout(r, 10));
    check('D ▶タップで再開: 再生開始', log.started === 1 && Listen.isPlaying() && ctx().state === 'running');
    // E
    ctx().setState('interrupted');
    check('E 再生中に interrupted: UI を一時停止に', !Listen.isPlaying() && log.playing[log.playing.length - 1] === false);
  }
  { // F
    const { Listen, log } = makeEnv({ decodeFails: true });
    await Listen.playRange(0, 3, 50);
    check('F 構築失敗: build-failed 通知', log.notices.some((n) => n.startsWith('build-failed:EncodingError')) && log.started === 0);
  }
  { // G
    const { Listen, log, ctx } = makeEnv({ initialState: 'running' });
    await Listen.playRange(0, 3, 50);
    Listen.pause();
    ctx().state = 'suspended';
    ctx().resumeMode = 'hang';
    Listen.toggle();          // ensureRunning で待機中
    Listen.stop();            // その間に停止
    ctx().resumeMode = 'ok';
    ctx().setState('running');
    await new Promise((r) => setTimeout(r, 1700));
    check('G 待機中に stop: 鳴り出さない', log.started === 1 && !Listen.isPlaying() && !Listen.isActive());
  }
  console.log(fails ? `\n${fails} 件 FAIL` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
