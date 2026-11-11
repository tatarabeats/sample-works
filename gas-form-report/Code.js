/**
 * フォーム回答の整形・集計・通知の下書き（Google Apps Script）— 自主制作の見本（架空のデータ）
 *
 * 使い方（スプレッドシートに貼る場合）:
 *   1. Google フォームの回答先スプレッドシートを開き、拡張機能 → Apps Script にこのファイルを貼る
 *   2. runReport を一度手動で実行して権限を許可する
 *   3. トリガーで「フォーム送信時」に runReport を設定する
 * 動き:
 *   「フォームの回答 1」シート → 表記をそろえて「整形」シートへ → 種別×月の件数を「集計」シートへ
 *   → 未対応の件があれば担当者あての Gmail 下書きを作る（自動送信はしない。中身を見てから送る）
 *
 * 上半分は Google のサービスを使わない純粋な関数なので、ブラウザーや Node でも同じ結果を確かめられる。
 */

var FR_CONFIG = {
  sourceSheet: 'フォームの回答 1',
  cleanSheet: '整形',
  summarySheet: '集計',
  notifyTo: 'tantou@example.com', // 架空の宛先
  headers: ['受付ID', '受付日時', 'お名前', '電話番号', 'メール', '種別', '内容', '状態']
};

/** 全角英数・記号を半角に、前後と連続の空白を1つに */
function frToHalf(s) {
  return String(s == null ? '' : s)
    .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 電話番号を 0X0-XXXX-XXXX などの形にそろえる。桁が合わなければ空にして「要確認」へ回す */
function frPhone(s) {
  var d = frToHalf(s).replace(/[^\d]/g, '');
  if (/^0[789]0\d{8}$/.test(d)) return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
  if (/^0\d{9}$/.test(d)) return d.slice(0, 2) + '-' + d.slice(2, 6) + '-' + d.slice(6);
  return '';
}

/** 「2026/11/3 9:05:00」「2026-11-03T09:05」などを Date に */
function frDate(v) {
  if (v instanceof Date) return v;
  var m = frToHalf(v).match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}

function frPad(n) { return (n < 10 ? '0' : '') + n; }
function frFmt(d) { return d.getFullYear() + '-' + frPad(d.getMonth() + 1) + '-' + frPad(d.getDate()) + ' ' + frPad(d.getHours()) + ':' + frPad(d.getMinutes()); }

var FR_KIND = [
  [/解約|退会|キャンセル/, '解約'], // 「予約をキャンセル」を予約に入れないよう先に見る
  [/予約|来店|日程/, '予約'],
  [/見積|料金|価格|いくら/, '見積'],
  [/./, 'その他']
];

/** 回答の行（見出し行を除く2次元配列）→ 整形済みの行・要確認の行 */
function frClean(rows) {
  var clean = [], review = [], seen = {};
  rows.forEach(function (r, i) {
    var at = frDate(r[0]), name = frToHalf(r[1]), tel = frPhone(r[2]);
    var mail = frToHalf(r[3]).toLowerCase(), kindRaw = frToHalf(r[4]), body = frToHalf(r[5]);
    var problems = [];
    if (!at) problems.push('日時が読めない');
    if (!name) problems.push('お名前が空');
    if (!tel && !mail) problems.push('連絡先が無い');
    if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) problems.push('メールの形が不正');
    var key = (mail || tel) + '|' + body;
    if (seen[key]) problems.push('重複（' + seen[key] + 'と同じ内容）');
    var id = 'R' + frPad(Math.floor((i + 1) / 100)) + frPad((i + 1) % 100);
    seen[key] = seen[key] || id;
    var kind = '';
    for (var k = 0; k < FR_KIND.length; k++) if (FR_KIND[k][0].test(kindRaw + body)) { kind = FR_KIND[k][1]; break; }
    var row = [id, at ? frFmt(at) : '', name, tel, mail, kind, body, problems.length ? '要確認' : '未対応'];
    if (problems.length) review.push({ id: id, line: i + 2, problems: problems });
    clean.push(row);
  });
  return { clean: clean, review: review };
}

/** 種別×月の件数表（見出し行つき） */
function frSummary(clean) {
  var months = {}, kinds = ['予約', '見積', '解約', 'その他'], table = {};
  clean.forEach(function (r) {
    if (!r[1] || r[7] === '要確認') return;
    var ym = r[1].slice(0, 7); months[ym] = 1;
    table[ym + '|' + r[5]] = (table[ym + '|' + r[5]] || 0) + 1;
  });
  var ms = Object.keys(months).sort();
  var out = [['月'].concat(kinds).concat(['合計'])];
  ms.forEach(function (m) {
    var row = [m], sum = 0;
    kinds.forEach(function (k) { var n = table[m + '|' + k] || 0; row.push(n); sum += n; });
    out.push(row.concat([sum]));
  });
  return out;
}

/** 担当者への通知の下書き（件名と本文） */
function frNotice(clean, review) {
  var open = clean.filter(function (r) { return r[7] === '未対応'; });
  if (!open.length && !review.length) return null;
  var lines = ['フォームの回答の確認をお願いします。', '', '未対応 ' + open.length + '件 / 要確認 ' + review.length + '件', ''];
  open.slice(0, 10).forEach(function (r) { lines.push('・' + r[0] + ' ' + r[1] + ' ' + r[5] + ' ' + r[2] + '様'); });
  if (review.length) {
    lines.push('', '要確認（シートの行番号と理由）:');
    review.forEach(function (x) { lines.push('・' + x.line + '行目 ' + x.problems.join('、')); });
  }
  return { subject: '【フォーム】未対応' + open.length + '件・要確認' + review.length + '件', body: lines.join('\n') };
}

/** 純粋な関数だけで全部の結果を返す（ブラウザーの動作確認・Node の試験で使う） */
function frBuild(rows) {
  var c = frClean(rows);
  return { clean: c.clean, review: c.review, summary: frSummary(c.clean), notice: frNotice(c.clean, c.review) };
}

/* ---------- ここから Google のサービスを使う部分（Apps Script の中でだけ動く） ---------- */

function frWrite_(ss, name, values) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  if (values.length) sh.getRange(1, 1, values.length, values[0].length).setValues(values);
  sh.setFrozenRows(1);
  return sh;
}

function runReport() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(FR_CONFIG.sourceSheet);
  var values = src.getDataRange().getValues().slice(1); // 見出し行を除く
  var r = frBuild(values);
  frWrite_(ss, FR_CONFIG.cleanSheet, [FR_CONFIG.headers].concat(r.clean));
  frWrite_(ss, FR_CONFIG.summarySheet, r.summary);
  if (r.notice) GmailApp.createDraft(FR_CONFIG.notifyTo, r.notice.subject, r.notice.body);
  return r;
}

if (typeof module !== 'undefined') module.exports = { frToHalf: frToHalf, frPhone: frPhone, frDate: frDate, frClean: frClean, frSummary: frSummary, frNotice: frNotice, frBuild: frBuild, runReport: runReport, FR_CONFIG: FR_CONFIG };
