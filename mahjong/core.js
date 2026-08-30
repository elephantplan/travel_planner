// 純計算邏輯（唔掂 DOM、唔掂網絡），方便自測。
// 每局金額由資料庫 settle_round() 計，呢度負責前端預覽同埋埋數。
import { FAN_TYPES } from './config.js';

export function fanAmount(ruleset, fan) {
  const f = Math.min(Math.max(Number(fan) || ruleset.minFan, ruleset.minFan), ruleset.maxFan);
  return Number(ruleset.table[f]);
}

// 同 SQL settle_round() 一模一樣嘅計法，用嚟做確認前預覽
export function settleRound(ruleset, { kind, winner, loser, fan }) {
  const d = [0, 0, 0, 0];
  if (kind === 'draw') return d;

  if (kind === 'false_win') {
    const a = ruleset.falseWinAmount != null
      ? Number(ruleset.falseWinAmount)
      : fanAmount(ruleset, ruleset.maxFan);
    for (let i = 0; i < 4; i++) d[i] = i === winner ? -3 * a : a;
    return d;
  }

  const a = fanAmount(ruleset, fan);
  if (loser == null) {
    for (let i = 0; i < 4; i++) d[i] = i === winner ? 3 * a : -a;
  } else if (ruleset.payMode === 'full') {
    d[winner] = 3 * a;
    d[loser] = -3 * a;
  } else {
    d[winner] = 2 * a;
    d[loser] = -a;
    for (let i = 0; i < 4; i++) if (i !== winner && i !== loser) d[i] = -a / 2;
  }
  return d;
}

export function fanFromTypes(ids, ruleset) {
  const picked = FAN_TYPES.filter((t) => ids.includes(t.id));
  if (picked.some((t) => t.limit)) return ruleset.maxFan;
  return picked.reduce((s, t) => s + t.fan, 0);
}

// 勾一個番種之後，應該剩返邊啲（處理互斥）
export function applyExclusions(ids, justPicked) {
  const t = FAN_TYPES.find((x) => x.id === justPicked);
  if (!t) return ids;
  const dropped = new Set(t.excludes || []);
  return ids.filter((id) => id === justPicked || !dropped.has(id));
}

// 每個座位嘅累計
export function seatTotals(rounds) {
  const t = [0, 0, 0, 0];
  for (const r of rounds) for (let i = 0; i < 4; i++) t[i] += Number(r.deltas[i]);
  return t;
}

// 每個「人」嘅累計：換過人嘅話，數跟返佢喺枱嘅嗰段局數
export function playerLedger(seats, rounds) {
  return seats.map((s) => {
    const mine = rounds.filter(
      (r) => r.seq > s.from_seq && (s.to_seq == null || r.seq <= s.to_seq),
    );
    return {
      seat: s.seat,
      name: s.player_name,
      active: s.to_seq == null,
      rounds: mine.length,
      wins: mine.filter((r) => r.kind === 'win' && r.winner_seat === s.seat).length,
      deals: mine.filter((r) => r.kind === 'win' && r.loser_seat === s.seat).length,
      total: mine.reduce((sum, r) => sum + Number(r.deltas[s.seat]), 0),
    };
  });
}

// 找數：邊個俾邊個幾多，交易次數盡量少
export function settlement(ledger) {
  const byName = new Map();
  for (const p of ledger) byName.set(p.name, (byName.get(p.name) || 0) + p.total);

  const owe = [], get = [];
  for (const [name, amt] of byName) {
    if (amt < -0.001) owe.push({ name, amt: -amt });
    else if (amt > 0.001) get.push({ name, amt });
  }
  owe.sort((a, b) => b.amt - a.amt);
  get.sort((a, b) => b.amt - a.amt);

  const tx = [];
  let i = 0, j = 0;
  while (i < owe.length && j < get.length) {
    const pay = Math.min(owe[i].amt, get[j].amt);
    tx.push({ from: owe[i].name, to: get[j].name, amt: pay });
    owe[i].amt -= pay;
    get[j].amt -= pay;
    if (owe[i].amt < 0.001) i++;
    if (get[j].amt < 0.001) j++;
  }
  return tx;
}

export function money(n) {
  const v = Number(n);
  const s = Number.isInteger(v) ? String(Math.abs(v)) : Math.abs(v).toFixed(2).replace(/\.?0+$/, '');
  return (v < 0 ? '-$' : '$') + s;
}
