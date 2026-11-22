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
 *   S) state='running' なのに時計(currentTime)が進まない（iOS）: 一時停止＋blocked。
 *      次の ▶ で AudioContext を作り直して再生できる。開始直後は 3 秒の猶予。
 *   R) ロック/バックグラウンドで rAF が止まった空白期間は停止判定に数えない。
 *
 * 使い方: node app/verify/verify_listen_resume.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ListenBuild = require('../js/listen-build.js');

const SRC = fs.readFileSync(path.join(__dirname, '../js/listen.js'), 'utf8') + '\n;this.Listen = Listen;';

// resumeMode: 'ok'（running にして解決）| 'hang'（解決しない・状態不変）| 'reject'
// clock: 'static'（currentTime 固定。rAF を回さない既存ケース用）| 'run'（実時間で進む）| 'stuck'（進まない）
function makeEnv({ initialState = 'running', resumeMode = 'ok', decodeFails = false, clock = 'static', raf = false } = {}) {
  const log = { started: 0, notices: [], playing: [], ctxCount: 0 };
  const env = { clock, rafPaused: false, rafQueue: [] };
  let ctxRef = null;
  class FakeCtx {
    constructor() {
      this.state = initialState; this.sampleRate = 8000; this.currentTime = 0;
      this.destination = {}; this.resumeMode = resumeMode; ctxRef = this;
      this.t0 = Date.now(); this.clock = env.clock; log.ctxCount++;
    }
    get currentTime() { return this.clock === 'run' ? (Date.now() - this.t0) / 1000 : 0; }
    set currentTime(v) {}
    close() { this.state = 'closed'; return Promise.resolve(); }
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
      return { connect() {}, disconnect() {}, stop() {}, start(when, off) { log.started++; log.lastOffset = off; } };
    }
    createGain() { return { connect() {} }; }
  }
  const sandbox = {
    window: { AudioContext: FakeCtx },
    navigator: {},
    ListenBuild,
    Splitter: { detectSilences: () => [] },
    // env.rafPaused=true の間は rAF を溜めておく（画面ロック中の再現）
    requestAnimationFrame: raf ? (cb) => (env.rafPaused ? (env.rafQueue.push(cb), 1) : setTimeout(cb, 16)) : () => 1,
    cancelAnimationFrame: raf ? (id) => clearTimeout(id) : () => {},
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
  return { Listen, log, ctx: () => ctxRef, env };
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
    ctx().setState('running');
    await new Promise((r) => setTimeout(r, 10));
    check('E 割り込み終了(running)で自動再開', log.started === 2 && Listen.isPlaying());
    Listen.pause();
    ctx().setState('suspended');
    ctx().setState('running');
    await new Promise((r) => setTimeout(r, 10));
    check('E 利用者の一時停止は自動再開しない', log.started === 2 && !Listen.isPlaying());
  }
  { // H
    const { Listen, log, ctx } = makeEnv({ initialState: 'interrupted', resumeMode: 'hang' });
    await Listen.playRange(0, 3, 50);
    ctx().setState('running');
    await new Promise((r) => setTimeout(r, 10));
    check('H blocked 後に running へ戻ると自動で鳴る', log.started === 1 && Listen.isPlaying());
  }
  { // I
    const { Listen, log, ctx } = makeEnv({ initialState: 'running' });
    await Listen.playRange(0, 3, 50);
    Listen.pause();
    ctx().state = 'suspended';
    ctx().resumeMode = 'hang';
    Listen.toggle();          // 再開待ち
    Listen.next();            // 待機中に ⏭（語2の頭 = 2秒 + 0.3秒ギャップ）
    ctx().state = 'running';  // 待機明けに running（statechange なし）
    await new Promise((r) => setTimeout(r, 1700));
    check('I 待機中の ⏭ が反映され次の語から鳴る',
      log.started === 2 && Listen.isPlaying() && Math.abs(log.lastOffset - 2.3) < 0.01);
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
  { // S
    const { Listen, log, env } = makeEnv({ clock: 'stuck', raf: true });
    await Listen.playRange(0, 3, 50);
    check('S 時計停止: 開始直後は再生中表示', Listen.isPlaying() && log.started === 1);
    await new Promise((r) => setTimeout(r, 2000));
    check('S 開始直後の猶予(3秒)内は判定しない', Listen.isPlaying());
    await new Promise((r) => setTimeout(r, 1700));
    check('S 時計停止を検知: 一時停止＋blocked 通知',
      !Listen.isPlaying() && log.notices.includes('blocked') && log.playing[log.playing.length - 1] === false);
    env.clock = 'run'; // 作り直した AudioContext は正常に進む
    Listen.toggle();   // ▶（ユーザー操作）
    await new Promise((r) => setTimeout(r, 2200));
    check('S ▶で AudioContext を作り直して再生継続', log.ctxCount === 2 && log.started === 2 && Listen.isPlaying());
    Listen.stop();
  }
  { // R: rAF が止まっていた空白期間（ロック中）は数えない
    const { Listen, log, env, ctx } = makeEnv({ clock: 'run', raf: true });
    await Listen.playRange(0, 3, 50);
    await new Promise((r) => setTimeout(r, 300)); // 一度進むのを観測
    env.rafPaused = true;                          // 画面ロック
    ctx().clock = 'stuck';                         // ロック中に時計が止まり、まだ statechange は来ていない
    await new Promise((r) => setTimeout(r, 2500));
    env.rafPaused = false;                         // 解除 → 溜まった tick が走る
    env.rafQueue.splice(0).forEach((cb) => setTimeout(cb, 0));
    await new Promise((r) => setTimeout(r, 200));
    check('R ロック解除直後は空白期間を停止と誤判定しない', Listen.isPlaying() && !log.notices.includes('blocked'));
    ctx().setState('interrupted');                 // 遅れて割り込み通知 → statechange 経由で一時停止
    ctx().setState('running');                     // 割り込み終了 → 自動再開（E の経路が生きている）
    ctx().clock = 'run';
    await new Promise((r) => setTimeout(r, 50));
    check('R その後の割り込み終了で自動再開（作り直し不要）', Listen.isPlaying() && log.ctxCount === 1);
    Listen.stop();
  }
  { // S2: 正常に進む時計では誤検知しない
    const { Listen, log } = makeEnv({ clock: 'run', raf: true });
    await Listen.playRange(0, 3, 50);
    await new Promise((r) => setTimeout(r, 2200));
    check('S2 正常な時計では誤検知しない', Listen.isPlaying() && !log.notices.includes('blocked') && log.ctxCount === 1);
    Listen.stop();
  }
  console.log(fails ? `\n${fails} 件 FAIL` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
