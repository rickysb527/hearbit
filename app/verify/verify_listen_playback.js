#!/usr/bin/env node
/* 聞き流し（listen.js）の再生ロジック検証（<audio> 要素方式）。
 *
 * 聞き流しは連結1本を WAV にして <audio> 要素で鳴らす（iOS でバックグラウンド/ロック中も止まらない）。
 * モックの Audio / URL / AudioContext(decode のみ) を入れた vm 上で実コード（listen.js）を動かし、
 * 状態遷移を確認する。WAV 変換（listen-build.js の encodeWav）は実コードを直接検証する。
 *
 * 確認項目:
 *   W) encodeWav: RIFF/WAVE ヘッダ・16bit モノラル・44.1/48kHz を 1/2 に間引く・値のクリップ。
 *   A) 開始: タップ直後に無音でアンロック → 構築後に blob の WAV を載せて play、再生中になる。
 *   B) play() が拒否される（iOS で操作外）: 一時停止表示 + blocked 通知。▶ で再生できる。
 *   C) OS 側の中断（着信等で要素が pause）: UI が一時停止に揃う。▶ で続きから。
 *   D) ⏭: 次の語の先頭へ currentTime を移す。
 *   E) 末尾まで再生: ended で停止、▶ で頭から。
 *   F) トラック構築失敗・WAV の読み込み失敗: build-failed 通知（▶ を促さない）。
 *   G) 新しいトラック開始・stop で前のトラックの blob URL を解放。構築中の stop で鳴り出さない。
 *   H) アンロック用の無音の play/pause/ended イベントで状態が乱れない。
 *
 * 使い方: node app/verify/verify_listen_playback.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ListenBuild = require('../js/listen-build.js');

const SRC = fs.readFileSync(path.join(__dirname, '../js/listen.js'), 'utf8') + '\n;this.Listen = Listen;';

let fails = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ---- W) encodeWav ----
{
  const n = 4410; // 0.1s @44.1kHz
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = i % 2 ? 1.5 : -0.5; // 平均 0.5、クリップ確認用に 1.5 を含む
  const { wav, sampleRate } = ListenBuild.encodeWav(pcm, 44100);
  const v = new DataView(wav);
  const str = (o, l) => String.fromCharCode(...new Uint8Array(wav, o, l));
  check('W RIFF/WAVE/fmt/data ヘッダ', str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE' && str(12, 4) === 'fmt ' && str(36, 4) === 'data');
  check('W 16bit PCM モノラル', v.getUint16(20, true) === 1 && v.getUint16(22, true) === 1 && v.getUint16(34, true) === 16);
  check('W 44.1kHz → 22050Hz に間引き', sampleRate === 22050 && v.getUint32(24, true) === 22050);
  check('W データ長 = サンプル数/2 × 2byte', v.getUint32(40, true) === (n / 2) * 2 && wav.byteLength === 44 + n);
  // 隣り合う2サンプル(-0.5, 1.5)の平均 0.5 → 0x7fff*0.5
  check('W 2サンプル平均で間引く', Math.abs(v.getInt16(44, true) - Math.round(0x7fff * 0.5)) <= 1, v.getInt16(44, true));
  const clip = ListenBuild.encodeWav(new Float32Array([2, -2]), 22050);
  const cv = new DataView(clip.wav);
  check('W ±1 を超える値はクリップ', cv.getInt16(44, true) === 0x7fff && cv.getInt16(46, true) === -0x8000);
  check('W 22050Hz 以下は間引かない', ListenBuild.encodeWav(new Float32Array(10), 22050).sampleRate === 22050);
}

// ---- 再生ロジック用のモック環境 ----
// playMode: 'ok' | 'reject'（NotAllowedError）
function makeEnv({ playMode = 'ok', decodeFails = false, loadFails = false } = {}) {
  const log = { plays: 0, notices: [], playing: [], revoked: [], created: 0 };
  const env = { playMode, loadFails };
  class FakeAudio {
    constructor() {
      this.listeners = {}; this._src = ''; this.currentTime = 0; this.paused = true; this.ended = false;
      this.readyState = 0; this.duration = NaN; env.audio = this;
    }
    get src() { return this._src; }
    set src(v) {
      this._src = v; this.readyState = 0; this.ended = false; this.currentTime = 0; this.error = null;
      // 代入で読み込み開始（ブラウザと同じ）。env.loadFails ならトラックの読み込みを失敗させる
      if (v) setTimeout(() => {
        if (this._src !== v) return;
        if (env.loadFails && v.startsWith('blob:track')) { this.error = { code: 4 }; this.emit('error'); return; }
        this.readyState = 1; this.emit('loadedmetadata');
      }, 1);
    }
    removeAttribute(k) { if (k === 'src') this._src = ''; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
    emit(t) { (this.listeners[t] || []).slice().forEach((f) => f()); }
    load() {}
    play() {
      if (env.playMode === 'reject' && this._src.startsWith('blob:track')) {
        return Promise.reject(Object.assign(new Error('NotAllowedError'), { name: 'NotAllowedError' }));
      }
      log.plays++;
      if (!this._src.startsWith('blob:track')) log.unlockPlays = (log.unlockPlays || 0) + 1;
      this.paused = false; this.ended = false; this.emit('play');
      return Promise.resolve();
    }
    pause() { if (this.paused) return; this.paused = true; this.emit('pause'); }
    // テスト用: 末尾まで再生しきった
    finish() { this.currentTime = 99; this.paused = true; this.ended = true; this.emit('pause'); this.emit('ended'); }
  }
  class FakeCtx {
    constructor() { this.sampleRate = 8000; }
    decodeAudioData(arr, res, rej) {
      if (decodeFails) { rej(new Error('EncodingError')); return; }
      const d = new Float32Array(8000 * 10);
      res({ sampleRate: 8000, length: d.length, numberOfChannels: 1, getChannelData: () => d });
    }
  }
  let urlSeq = 0;
  const sandbox = {
    window: { AudioContext: FakeCtx },
    Audio: FakeAudio,
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
    URL: {
      // 0.1 秒の無音（アンロック用）とトラックを URL で区別する
      createObjectURL: (b) => { log.created++; return (b.parts[0].byteLength > 44 + 2205 * 2 ? 'blob:track' : 'blob:silent') + (++urlSeq); },
      revokeObjectURL: (u) => log.revoked.push(u),
    },
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
    page: '001', serial: i + 1, seg: { index: i, start: i * 3, end: i * 3 + 2, type: 'word' },
  }));
  Listen.configure({
    bookName: 'test', words,
    getBlobFor: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
    ui: {
      onPlaying: (p) => log.playing.push(p),
      onNotice: (kind, err) => log.notices.push(err ? `${kind}:${err.message}` : kind),
    },
  });
  return { Listen, log, env, audio: () => env.audio };
}
const lastPlaying = (log) => log.playing[log.playing.length - 1];

(async () => {
  { // A, D, E
    const { Listen, log, audio } = makeEnv();
    await Listen.playRange(0, 3, 50);
    check('A 開始前に無音でアンロック（操作直後の play）', log.unlockPlays === 1);
    check('A blob の WAV を載せて再生中', /^blob:track/.test(audio().src) && !audio().paused && Listen.isPlaying() && lastPlaying(log) === true);
    // D: ⏭ → 2語目の先頭（クリップ 2 秒 + ギャップ 0.3 秒 = 2.3 秒）
    audio().currentTime = 0.5;
    Listen.next();
    await tick();
    check('D ⏭ で次の語の先頭へ', Math.abs(audio().currentTime - 2.3) < 0.01 && Listen.isPlaying(), audio().currentTime);
    // E: 末尾まで
    audio().finish();
    check('E 末尾で停止表示', !Listen.isPlaying() && lastPlaying(log) === false && Listen.isActive());
    Listen.toggle(); // ▶
    await tick();
    check('E 末尾の後の ▶ は頭から', audio().currentTime === 0 && Listen.isPlaying());
  }
  { // B
    const { Listen, log, env, audio } = makeEnv({ playMode: 'reject' });
    await Listen.playRange(0, 3, 50);
    check('B play() 拒否: 一時停止表示 + blocked 通知', !Listen.isPlaying() && lastPlaying(log) === false && log.notices.includes('blocked'));
    env.playMode = 'ok';
    Listen.toggle(); // ▶（ユーザー操作）
    await tick();
    check('B ▶ で再生できる', Listen.isPlaying() && !audio().paused);
  }
  { // C
    const { Listen, log, audio } = makeEnv();
    await Listen.playRange(0, 3, 50);
    audio().currentTime = 3.1;
    audio().pause(); // OS 側の中断（着信など）
    check('C OS 側の中断で UI が一時停止に揃う', !Listen.isPlaying() && lastPlaying(log) === false);
    Listen.toggle();
    await tick();
    check('C ▶ で中断位置から再開', Listen.isPlaying() && Math.abs(audio().currentTime - 3.1) < 0.01, audio().currentTime);
  }
  { // F
    const { Listen, log } = makeEnv({ decodeFails: true });
    await Listen.playRange(0, 3, 50);
    check('F 構築失敗: build-failed 通知', log.notices.some((n) => n.startsWith('build-failed:EncodingError')) && !Listen.isPlaying());
  }
  { // F2
    const { Listen, log } = makeEnv({ loadFails: true });
    await Listen.playRange(0, 3, 50);
    check('F WAV 読み込み失敗: build-failed 通知（blocked ではない）',
      log.notices.some((n) => n.startsWith('build-failed:audio load error')) && !log.notices.includes('blocked') && !Listen.isPlaying(),
      JSON.stringify(log.notices));
  }
  { // G, H
    const { Listen, log, audio } = makeEnv();
    await Listen.playRange(0, 3, 50);
    const firstUrl = audio().src;
    await Listen.playRange(1, 3, 50);
    check('G 新しいトラック開始で前の URL を解放', log.revoked.includes(firstUrl) && audio().src !== firstUrl && Listen.isPlaying());
    const secondUrl = audio().src;
    Listen.stop();
    check('G stop で URL 解放・要素も止まる', log.revoked.includes(secondUrl) && audio().paused && !Listen.isActive());
    // 構築中に stop → 鳴り出さない
    const p = Listen.playRange(0, 3, 50);
    Listen.stop();
    await p;
    await tick(30);
    check('G 構築中の stop: 鳴り出さない', !Listen.isPlaying() && !/^blob:track/.test(audio().src || ''));
    // H: アンロック用無音の ended/pause が来ても、トラック再生中の状態は乱れない
    await Listen.playRange(0, 3, 50);
    const playingBefore = Listen.isPlaying();
    const a = audio();
    const saved = a._src; a._src = 'blob:silent-x'; a.emit('pause'); a.emit('ended'); a._src = saved;
    check('H 無音のイベントで状態が乱れない', playingBefore && Listen.isPlaying() && lastPlaying(log) === true);
  }
  console.log(fails ? `\n${fails} 件 FAIL` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
