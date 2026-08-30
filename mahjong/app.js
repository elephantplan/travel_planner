import { SUPABASE_URL, SUPABASE_KEY, PRESETS, FAN_TYPES, SEAT_WINDS } from './config.js';
import {
  settleRound, fanFromTypes, applyExclusions, playerLedger, settlement, money,
} from './core.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

const state = {
  room: null, hostKey: null, game: null, seats: [], rounds: [],
  preset: PRESETS[0], tableDraft: null,
  draft: { kind: 'win', winner: null, loser: undefined, fan: null, types: [] },
  subSeat: null, tab: 'log',
};

const isHost = () => !!state.hostKey;
const setStatus = (t) => { $('status').textContent = t || ''; };

// host key 存喺瀏覽器（只係「我係開局嗰個」嘅憑證，牌局資料全部喺 Supabase）
const keyOf = (room) => `mahjong.hostkey.${room}`;
function loadHostKey(room) { try { return localStorage.getItem(keyOf(room)); } catch { return null; } }
function saveHostKey(room, k) { try { localStorage.setItem(keyOf(room), k); } catch { /* 無痕模式 */ } }

// ── 開局頁 ─────────────────────────────
function renderSetup() {
  $('presetList').innerHTML = '';
  [...PRESETS, { id: 'custom', name: '自訂', desc: '自己入每格金額' }].forEach((p) => {
    const b = document.createElement('button');
    b.className = 'ghost' + (state.preset.id === p.id ? ' sel' : '');
    b.style.textAlign = 'left';
    if (state.preset.id === p.id) b.style.outline = '2px solid var(--accent)';
    b.innerHTML = `<div style="font-weight:700">${p.name}</div><div class="muted">${p.desc}</div>`;
    b.onclick = () => {
      state.preset = p.id === 'custom'
        ? { ...PRESETS[0], id: 'custom', name: '自訂', desc: '自己入每格金額' }
        : p;
      state.tableDraft = { ...state.preset.table };
      renderSetup();
    };
    $('presetList').appendChild(b);
  });

  const custom = state.preset.id === 'custom';
  $('tableEdit').classList.toggle('hidden', !custom);
  if (custom) {
    state.tableDraft = state.tableDraft || { ...state.preset.table };
    $('tableInputs').innerHTML = '';
    for (let f = state.preset.minFan; f <= state.preset.maxFan; f++) {
      const wrap = document.createElement('label');
      wrap.innerHTML = `<div class="muted">${f} 番</div>`;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.inputMode = 'numeric'; inp.value = state.tableDraft[f] ?? '';
      inp.oninput = () => { state.tableDraft[f] = Number(inp.value) || 0; };
      wrap.appendChild(inp);
      $('tableInputs').appendChild(wrap);
    }
  }

  if (!$('nameInputs').children.length) {
    SEAT_WINDS.forEach((w, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.marginBottom = '8px';
      row.innerHTML = `<div style="width:34px;color:var(--accent);font-weight:700">${w}</div>`;
      const inp = document.createElement('input');
      inp.id = `name${i}`; inp.placeholder = `第 ${i + 1} 位玩家`; inp.autocomplete = 'off';
      row.appendChild(inp);
      $('nameInputs').appendChild(row);
    });
  }
}

async function startGame() {
  const names = [0, 1, 2, 3].map((i) => $(`name${i}`).value.trim() || `玩家${i + 1}`);
  const p = state.preset;
  const ruleset = {
    name: p.name, minFan: p.minFan, maxFan: p.maxFan,
    payMode: $('payMode').value,
    table: p.id === 'custom' ? state.tableDraft : p.table,
  };
  const hostKey = crypto.randomUUID();
  $('startBtn').disabled = true;
  setStatus('開緊局…');
  const { data, error } = await sb.rpc('create_game', {
    p_ruleset: ruleset, p_names: names, p_host_key: hostKey,
  });
  $('startBtn').disabled = false;
  if (error) { alert('開局失敗：' + error.message); return; }
  saveHostKey(data, hostKey);
  location.search = `?r=${data}`;
}

// ── 載入 + 實時 ─────────────────────────
async function loadGame(room) {
  const { data: g, error } = await sb.from('games').select('*').eq('room_code', room).maybeSingle();
  if (error || !g) { alert('搵唔到呢局牌，個 link 可能錯咗'); location.search = ''; return; }
  state.game = g;
  const [{ data: seats }, { data: rounds }] = await Promise.all([
    sb.from('seats').select('*').eq('game_id', g.id).order('seat').order('from_seq'),
    sb.from('rounds').select('*').eq('game_id', g.id).order('seq'),
  ]);
  state.seats = seats || [];
  state.rounds = rounds || [];
  render();

  sb.channel(`game:${g.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: `game_id=eq.${g.id}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'seats', filter: `game_id=eq.${g.id}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${g.id}` }, refresh)
    .subscribe();
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  setTimeout(async () => {
    refreshing = false;
    const g = state.game;
    const [{ data: game }, { data: seats }, { data: rounds }] = await Promise.all([
      sb.from('games').select('*').eq('id', g.id).maybeSingle(),
      sb.from('seats').select('*').eq('game_id', g.id).order('seat').order('from_seq'),
      sb.from('rounds').select('*').eq('game_id', g.id).order('seq'),
    ]);
    if (game) state.game = game;
    state.seats = seats || [];
    state.rounds = rounds || [];
    render();
  }, 120);
}

const activeSeats = () => [0, 1, 2, 3].map(
  (i) => state.seats.filter((s) => s.seat === i && s.to_seq == null)[0]
        || state.seats.filter((s) => s.seat === i).slice(-1)[0],
);

// ── 主畫面 ─────────────────────────────
function render() {
  $('setup').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('rulesetName').textContent = state.game.ruleset.name || '麻雀';
  $('viewerBanner').classList.toggle('hidden', isHost());
  const finished = state.game.status === 'finished';
  $('finishedBanner').classList.toggle('hidden', !finished);
  $('hostActions').classList.toggle('hidden', !isHost());
  ['winBtn', 'drawBtn', 'falseWinBtn', 'subBtn', 'undoBtn', 'finishBtn'].forEach((b) => {
    $(b).classList.toggle('hidden', finished);
  });
  $('reopenBtn').classList.toggle('hidden', !finished);
  $('undoBtn').disabled = !state.rounds.length;

  const ledger = playerLedger(state.seats, state.rounds);
  const cur = activeSeats();
  $('seats').innerHTML = '';
  cur.forEach((s, i) => {
    const total = ledger.find((p) => p.seat === i && p.active)?.total ?? 0;
    const el = document.createElement('div');
    el.className = 'seat';
    el.innerHTML = `<div class="wind">${SEAT_WINDS[i]}</div>
      <div class="name">${escapeHtml(s.player_name)}</div>
      <div class="amt num ${total > 0 ? 'up' : total < 0 ? 'down' : ''}">${money(total)}</div>`;
    $('seats').appendChild(el);
  });

  renderLog();
  renderSettle(ledger);
}

function renderLog() {
  const cur = activeSeats();
  if (!state.rounds.length) {
    $('tabLog').innerHTML = '<div class="muted">仲未開始，撳「食糊」入第一局。</div>';
    return;
  }
  const nameAt = (seat, seq) => {
    const s = state.seats.filter((x) => x.seat === seat && x.from_seq < seq && (x.to_seq == null || seq <= x.to_seq))[0];
    return (s || cur[seat]).player_name;
  };
  const rows = state.rounds.slice().reverse().map((r) => {
    let desc;
    if (r.kind === 'draw') desc = '流局';
    else if (r.kind === 'false_win') desc = `${nameAt(r.winner_seat, r.seq)} 詐糊`;
    else if (r.loser_seat == null) desc = `${nameAt(r.winner_seat, r.seq)} 自摸 ${r.fan} 番`;
    else desc = `${nameAt(r.winner_seat, r.seq)} 食 ${nameAt(r.loser_seat, r.seq)} · ${r.fan} 番`;
    const types = (r.fan_types || []).length ? `<div class="muted">${r.fan_types.join('、')}</div>` : '';
    const amts = r.deltas.map((d, i) => {
      const v = Number(d);
      return `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : 'muted'}">${money(v)}</span>`;
    }).join(' · ');
    return `<tr><td>${r.seq}</td><td>${escapeHtml(desc)}${types}</td><td class="n num">${amts}</td></tr>`;
  }).join('');
  $('tabLog').innerHTML = `<table><thead><tr><th>局</th><th>結果</th>
    <th class="n">${cur.map((s) => escapeHtml(s.player_name)).join(' · ')}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderSettle(ledger) {
  const byName = new Map();
  for (const p of ledger) {
    const e = byName.get(p.name) || { name: p.name, total: 0, wins: 0, deals: 0, rounds: 0 };
    e.total += p.total; e.wins += p.wins; e.deals += p.deals; e.rounds += p.rounds;
    byName.set(p.name, e);
  }
  const people = [...byName.values()].sort((a, b) => b.total - a.total);
  const tx = settlement(ledger);

  const rows = people.map((p) => `<tr><td>${escapeHtml(p.name)}</td>
    <td class="n num">${p.wins}</td><td class="n num">${p.deals}</td>
    <td class="n num ${p.total > 0 ? 'up' : p.total < 0 ? 'down' : ''}"><b>${money(p.total)}</b></td></tr>`).join('');

  const txHtml = tx.length
    ? tx.map((t) => `<div style="padding:10px 0;border-bottom:1px solid var(--line)">
        <b>${escapeHtml(t.from)}</b> 俾 <b class="num up">${money(t.amt)}</b> <b>${escapeHtml(t.to)}</b></div>`).join('')
    : '<div class="muted">而家啱啱好，冇數要找。</div>';

  $('tabSettle').innerHTML = `
    <table><thead><tr><th>玩家</th><th class="n">食糊</th><th class="n">出銃</th><th class="n">輸贏</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <h2>點找數</h2>${txHtml}
    <button id="copyResult" class="ghost" style="width:100%;margin-top:12px">複製結果（貼落 WhatsApp）</button>`;

  $('copyResult').onclick = async () => {
    const text = [
      `🀄 麻雀計分 · ${state.game.ruleset.name} · 共 ${state.rounds.length} 局`,
      ...people.map((p) => `${p.name}：${money(p.total)}`),
      '', '找數：',
      ...tx.map((t) => `${t.from} → ${t.to} ${money(t.amt)}`),
    ].join('\n');
    try { await navigator.clipboard.writeText(text); setStatus('已複製 ✅'); }
    catch { prompt('複製呢段：', text); }
  };
}

// ── 入局對話框 ──────────────────────────
function openRoundDialog(kind) {
  state.draft = { kind, winner: null, loser: undefined, fan: null, types: [] };
  $('winTitle').textContent = kind === 'false_win' ? '邊個詐糊？' : '邊個食糊？';
  $('loserBlock').classList.toggle('hidden', kind !== 'win');
  $('fanBlock').classList.toggle('hidden', kind !== 'win');
  $('fanTypeChips').classList.add('hidden');
  renderDialog();
  $('winDlg').showModal();
}

function seatButtons(container, onPick, opts = {}) {
  const cur = activeSeats();
  container.innerHTML = '';
  cur.forEach((s, i) => {
    if (opts.skip === i) { container.appendChild(document.createElement('div')); return; }
    const b = document.createElement('button');
    b.className = 'ghost' + (opts.selected === i ? ' on' : '');
    if (opts.selected === i) { b.style.background = 'var(--accent)'; b.style.color = '#22190a'; b.style.fontWeight = '700'; }
    b.innerHTML = `<div style="font-size:11px;opacity:.7">${SEAT_WINDS[i]}</div>${escapeHtml(s.player_name)}`;
    b.onclick = () => onPick(i);
    container.appendChild(b);
  });
  if (opts.extra) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = opts.extra.label;
    if (opts.extraSelected) { b.style.background = 'var(--accent)'; b.style.color = '#22190a'; b.style.fontWeight = '700'; }
    b.onclick = opts.extra.onClick;
    container.appendChild(b);
  }
}

function renderDialog() {
  const d = state.draft;
  seatButtons($('winSeats'), (i) => { d.winner = i; if (d.loser === i) d.loser = undefined; renderDialog(); }, { selected: d.winner });

  if (d.kind === 'win') {
    seatButtons($('loserSeats'), (i) => { d.loser = i; renderDialog(); }, {
      selected: d.loser, skip: d.winner,
      extra: { label: '自摸', onClick: () => { d.loser = null; renderDialog(); } },
      extraSelected: d.loser === null,
    });

    $('fanKeys').innerHTML = '';
    const { minFan, maxFan } = state.game.ruleset;
    for (let f = minFan; f <= maxFan; f++) {
      const b = document.createElement('button');
      b.textContent = f;
      b.className = d.fan === f ? 'on' : '';
      b.onclick = () => { d.fan = f; d.types = []; renderDialog(); };
      $('fanKeys').appendChild(b);
    }

    $('fanTypeChips').innerHTML = '';
    FAN_TYPES.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'chip' + (d.types.includes(t.id) ? ' on' : '');
      b.textContent = `${t.name} ${t.limit ? '封頂' : '+' + t.fan}`;
      b.onclick = () => {
        d.types = d.types.includes(t.id)
          ? d.types.filter((x) => x !== t.id)
          : applyExclusions([...d.types, t.id], t.id);
        d.fan = d.types.length ? fanFromTypes(d.types, state.game.ruleset) : null;
        renderDialog();
      };
      $('fanTypeChips').appendChild(b);
    });
  }

  const ready = d.kind === 'false_win'
    ? d.winner != null
    : d.winner != null && d.loser !== undefined && d.fan != null;
  $('winOk').disabled = !ready;

  if (ready) {
    const deltas = settleRound(state.game.ruleset, d);
    const cur = activeSeats();
    $('preview').innerHTML = deltas.map((v, i) => `<div class="row" style="justify-content:space-between">
      <span>${escapeHtml(cur[i].player_name)}</span>
      <b class="num ${v > 0 ? 'up' : v < 0 ? 'down' : 'muted'}">${money(v)}</b></div>`).join('');
  } else {
    $('preview').innerHTML = '<div class="muted">揀齊先睇到加減</div>';
  }
}

// ── 寫入 ───────────────────────────────
async function call(fn, args, okMsg) {
  setStatus('儲存緊…');
  const { error } = await sb.rpc(fn, { p_room: state.room, p_host_key: state.hostKey, ...args });
  if (error) { setStatus(''); alert('儲存唔到：' + error.message); return false; }
  setStatus(okMsg || '已儲存 ✅');
  await refresh();
  return true;
}

// ── 綁掣 ───────────────────────────────
function bind() {
  $('startBtn').onclick = startGame;

  $('winBtn').onclick = () => openRoundDialog('win');
  $('falseWinBtn').onclick = () => openRoundDialog('false_win');
  $('drawBtn').onclick = async () => {
    if (confirm('記一局流局？')) await call('add_round', { p_kind: 'draw' });
  };
  $('undoBtn').onclick = async () => {
    if (confirm('撤銷上一局？')) await call('undo_last_round', {});
  };
  $('finishBtn').onclick = async () => {
    if (confirm('結束牌局，出最終找數？')) {
      if (await call('finish_game', {})) state.tab = 'settle', switchTab('settle');
    }
  };
  $('reopenBtn').onclick = async () => { await call('reopen_game', {}); };

  $('winCancel').onclick = () => $('winDlg').close();
  $('winOk').onclick = async () => {
    const d = state.draft;
    const types = d.types.map((id) => FAN_TYPES.find((t) => t.id === id).name);
    $('winDlg').close();
    await call('add_round', {
      p_kind: d.kind, p_winner: d.winner,
      p_loser: d.kind === 'win' ? d.loser : null,
      p_fan: d.kind === 'win' ? d.fan : null,
      p_fan_types: types,
    });
  };
  $('toggleFanTypes').onclick = () => {
    const el = $('fanTypeChips');
    el.classList.toggle('hidden');
    $('toggleFanTypes').classList.toggle('on', !el.classList.contains('hidden'));
  };

  const renderSubSeats = () => seatButtons($('subSeats'), (i) => {
    state.subSeat = i;
    renderSubSeats();
  }, { selected: state.subSeat });

  $('subBtn').onclick = () => {
    state.subSeat = null;
    $('subName').value = '';
    renderSubSeats();
    $('subDlg').showModal();
  };
  $('subCancel').onclick = () => $('subDlg').close();
  $('subOk').onclick = async () => {
    const name = $('subName').value.trim();
    if (state.subSeat == null || !name) { alert('揀個位同埋入個名先'); return; }
    $('subDlg').close();
    await call('substitute_player', { p_seat: state.subSeat, p_new_name: name });
  };

  $('shareBtn').onclick = () => {
    const url = `${location.origin}${location.pathname}?r=${state.room}`;
    $('shareUrl').value = url;
    if (navigator.share) navigator.share({ title: '麻雀計分', url }).catch(() => $('shareDlg').showModal());
    else $('shareDlg').showModal();
  };
  $('shareClose').onclick = () => $('shareDlg').close();
  $('shareCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('shareUrl').value); setStatus('連結已複製 ✅'); }
    catch { $('shareUrl').select(); }
    $('shareDlg').close();
  };

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => switchTab(b.dataset.tab);
  });
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('tabLog').classList.toggle('hidden', tab !== 'log');
  $('tabSettle').classList.toggle('hidden', tab !== 'settle');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── 起步 ───────────────────────────────
bind();
const room = new URLSearchParams(location.search).get('r');
if (room) {
  state.room = room;
  state.hostKey = loadHostKey(room);
  loadGame(room);
} else {
  state.tableDraft = { ...PRESETS[0].table };
  renderSetup();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
