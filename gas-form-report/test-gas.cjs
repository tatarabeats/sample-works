// Code.js を Apps Script の模擬環境（SpreadsheetApp・GmailApp の代わり）で動かし、結果を確かめる試験。
// 実行: node test-gas.cjs   → result.json を書き、確認項目の合否を表示する
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const dir = __dirname;

function parseCsv(text) {
  return text.trim().split(/\r?\n/).map(l => l.split(','));
}
const rows = parseCsv(fs.readFileSync(path.join(dir, 'sample-responses.csv'), 'utf8'));

// --- Apps Script の模擬 ---
const sheets = {}, drafts = [];
function sheet(name, values) {
  const s = { name, values: values || [], frozen: 0,
    getDataRange: () => ({ getValues: () => s.values.map(r => r.slice()) }),
    clearContents: () => { s.values = []; },
    getRange: (r, c, nr, nc) => ({ setValues: v => { assert.strictEqual(v.length, nr); v.forEach(x => assert.strictEqual(x.length, nc)); s.values = v.map(x => x.slice()); } }),
    setFrozenRows: n => { s.frozen = n; } };
  sheets[name] = s; return s;
}
sheet('フォームの回答 1', rows);
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => sheet(n) }) },
  GmailApp: { createDraft: (to, subject, body) => drafts.push({ to, subject, body }) },
  console,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'Code.js'), 'utf8'), ctx, { filename: 'Code.js' });
const r = JSON.parse(JSON.stringify(vm.runInContext('runReport()', ctx))); // vm の配列を通常の配列に

// --- 確認項目 ---
const checks = [];
function check(name, fn) { try { fn(); checks.push([name, true]); } catch (e) { checks.push([name, false, e.message]); } }
const clean = JSON.parse(JSON.stringify(sheets['整形'].values)), summary = JSON.parse(JSON.stringify(sheets['集計'].values));
check('整形シートは見出し＋15行', () => assert.strictEqual(clean.length, 16));
check('全角の電話番号を半角の形にそろえる', () => assert.strictEqual(clean[1][3], '090-1234-5678'));
check('固定電話は 0X-XXXX-XXXX', () => assert.strictEqual(clean[2][3], '03-0000-1111'));
check('メールは小文字にそろえる', () => assert.strictEqual(clean[3][4], 'jiro@example.com'));
check('不正なメールは要確認', () => assert.strictEqual(clean[4][7], '要確認'));
check('お名前が空は要確認', () => assert.strictEqual(clean[6][7], '要確認'));
check('同じ内容の再送は重複として要確認', () => assert.ok(r.review.some(x => x.line === 9 && /重複/.test(x.problems.join()))));
check('桁の合わない電話・メールなしは要確認', () => assert.ok(r.review.some(x => x.line === 13)));
check('「予約をキャンセル」は解約に入れる', () => assert.strictEqual(clean[12][5], '解約'));
check('ISO 形式の日時も読める', () => assert.strictEqual(clean[13][1], '2026-11-08 14:20'));
check('種別の振り分け（予約・見積・解約・その他）', () => assert.deepStrictEqual(clean.slice(1).map(x => x[5]).filter((v, i, a) => a.indexOf(v) === i).sort(), ['その他', '予約', '解約', '見積'].sort()));
check('集計は2か月分＋見出し', () => assert.strictEqual(summary.length, 3));
check('集計の合計＝未対応の件数', () => assert.strictEqual(summary.slice(1).reduce((a, x) => a + x[x.length - 1], 0), clean.filter(x => x[7] === '未対応').length));
check('通知は下書きを1通だけ作る（送信しない）', () => assert.strictEqual(drafts.length, 1));
check('通知の件名に件数が入る', () => assert.ok(/未対応\d+件・要確認\d+件/.test(drafts[0].subject)));
check('見出し行を固定する', () => assert.strictEqual(sheets['整形'].frozen, 1));

fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ clean, summary, review: r.review, draft: drafts[0], checks }, null, 1), 'utf8');
const failed = checks.filter(c => !c[1]);
checks.forEach(c => console.log((c[1] ? 'OK  ' : 'NG  ') + c[0] + (c[2] ? ' — ' + c[2] : '')));
console.log(`合格 ${checks.length - failed.length}/${checks.length}`);
process.exit(failed.length ? 1 : 0);
