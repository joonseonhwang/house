// 우리집노트 — 집 매매·인테리어·가전/가구 통합 관리 (개인용 PWA)
// 출처: [Claude] 설계·작성 / [사용자] 요구사항(2026-11-17 대화)
// 데이터는 이 기기의 IndexedDB에만 저장한다. 금액 단위는 '만원'.
'use strict';
const APP_VERSION = '1.1.1';
const DB_NAME = 'house-note';
const STORES = ['scenarios', 'budgets', 'payments', 'items', 'plans'];
const WHENS = ['잔금 전', '잔금일', '잔금 후', '미정'];
const PAYCATS = ['매매', '인테리어', '이사', '가전·가구', '기타'];
const ITEMCATS = ['가전', '가구', '인테리어'];
const STATUSES = ['검토중', '결정', '주문', '완료'];
// 평면도 공간 종류: [표시 이름, 바닥 색]
const KINDS = { room: ['침실', '#46557f'], living: ['거실', '#8a6a40'], kitchen: ['주방', '#7a5f37'], bath: ['욕실', '#2f6774'],
  entry: ['현관', '#5a606c'], closet: ['수납', '#5d4c7a'], balcony: ['발코니', '#373e4b'] };
const DAY = 86400000;

const S = { scenarios: [], budgets: [], payments: [], items: [], plans: [], meta: {} };
const UI = { itemCat: '전체', q: '', room: null, cam: { yaw: -0.55, pitch: 0.9, zoom: 1 } };
let db, installEvt = null;
const $ = s => document.querySelector(s);
const view = $('#view'), sheet = $('#sheet'), sheetBg = $('#sheet-bg');

/* ---------- 공통 ---------- */
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sum = (a, k = 'amount') => a.reduce((t, x) => t + (Number(x[k]) || 0), 0);
function won(m) {
  if (m == null || m === '') return '미정';
  let w = Math.round(Number(m) * 10000); // 만원 → 원 (544.7 → 5,447,000원)
  if (!w) return '0원';
  const neg = w < 0; w = Math.abs(w);
  const e = Math.floor(w / 1e8), r = Math.floor(w % 1e8 / 1e4), z = w % 1e4;
  const p = [e && e + '억', r && r.toLocaleString('ko-KR') + '만', z && z.toLocaleString('ko-KR')].filter(Boolean);
  return (neg ? '-' : '') + p.join(' ') + '원';
}
const pct = (a, b) => b > 0 ? Math.max(0, Math.min(100, Math.round(a / b * 100))) : 0;
function ymd(d = new Date()) { return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }
function dday(s) {
  if (!s) return '';
  const t = new Date(s + 'T00:00:00'), n = new Date(); n.setHours(0, 0, 0, 0);
  const d = Math.round((t - n) / DAY);
  return d === 0 ? 'D-DAY' : d > 0 ? 'D-' + d : 'D+' + (-d);
}
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const cho = s => [...s].map(c => { const k = c.charCodeAt(0) - 0xAC00; return k >= 0 && k < 11172 ? CHO[Math.floor(k / 588)] : c; }).join('');
function match(text, q) {
  text = text.toLowerCase(); const ct = cho(text);
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => text.includes(w) || (/^[ㄱ-ㅎ]+$/.test(w) && ct.includes(w)));
}
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2200); }

/* ---------- 저장소 ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = e => {
      const d = r.result;
      if (e.oldVersion < 1) { ['scenarios', 'budgets', 'payments', 'items'].forEach(s => d.createObjectStore(s, { keyPath: 'id' })); d.createObjectStore('meta', { keyPath: 'key' }); }
      if (e.oldVersion < 2) d.createObjectStore('plans', { keyPath: 'id' }); // v1.1.0: 평면도
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function tx(stores, fn) {
  return new Promise((res, rej) => { const t = db.transaction(stores, 'readwrite'); fn(t); t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });
}
function getAll(s) { return new Promise((res, rej) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function loadAll() {
  for (const s of STORES) S[s] = (await getAll(s)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  S.meta = {}; (await getAll('meta')).forEach(m => S.meta[m.key] = m.value);
}
async function put(store, obj) {
  if (!obj.id) obj.id = uid();
  if (obj.order == null) obj.order = Date.now();
  obj.updatedAt = Date.now();
  await tx([store], t => t.objectStore(store).put(obj)); await loadAll();
}
async function del(store, id) { await tx([store], t => t.objectStore(store).delete(id)); await loadAll(); }
async function setMeta(key, value) { await tx(['meta'], t => t.objectStore('meta').put({ key, value })); S.meta[key] = value; }
const hasData = () => STORES.some(s => S[s].length);

/* ---------- 백업 / 복원 ---------- */
function backupObj() { return { app: 'house-note', version: 2, exportedAt: Date.now(), data: Object.fromEntries(STORES.map(s => [s, S[s]])) }; }
function backupFile() { return new File([JSON.stringify(backupObj(), null, 1)], `우리집노트_백업_${ymd()}.json`, { type: 'application/json' }); }
async function exportBackup() {
  const f = backupFile(), a = document.createElement('a');
  a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  await setMeta('lastBackup', Date.now()); toast('백업 파일을 저장했어요'); render();
}
async function shareBackup() {
  const f = backupFile();
  if (!(navigator.canShare && navigator.canShare({ files: [f] }))) return toast('이 브라우저는 파일 공유를 지원하지 않아요. 내보내기를 쓰세요');
  try { await navigator.share({ files: [f], title: '우리집노트 백업' }); await setMeta('lastBackup', Date.now()); render(); } catch (e) { /* 취소 */ }
}
function validate(o) {
  if (!o || o.app !== 'house-note' || typeof o.data !== 'object' || !o.data) throw new Error('우리집노트 백업 파일이 아니에요');
  for (const s of STORES) {
    const a = o.data[s] ?? [];
    if (!Array.isArray(a) || a.some(r => !r || typeof r.id !== 'string' || !r.id)) throw new Error(`백업 파일 형식 오류 (${s})`);
  }
}
async function importData(o, mode) {
  validate(o);
  let n = 0;
  await tx(STORES, t => {
    for (const s of STORES) {
      const st = t.objectStore(s);
      // 파일에 들어 있는 종류만 바꾼다 (평면도만 든 파일로 '전체 바꾸기'를 해도 자금 데이터는 지워지지 않게)
      if (mode === 'replace' && Array.isArray(o.data[s])) st.clear();
      const cur = new Map(S[s].map(r => [r.id, r]));
      for (const r of o.data[s] ?? []) {
        const old = mode === 'merge' ? cur.get(r.id) : null;
        if (!old || (r.updatedAt || 0) > (old.updatedAt || 0)) { st.put(r); n++; }
      }
    }
  });
  await loadAll();
  return n;
}
async function clearAll() { await tx(STORES, t => STORES.forEach(s => t.objectStore(s).clear())); await loadAll(); }
function pickFile() { const f = $('#file'); f.value = ''; f.click(); }
$('#file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  let o;
  try { o = JSON.parse(await f.text()); validate(o); } catch (err) { return toast(err.message.includes('JSON') ? 'JSON 파일을 읽을 수 없어요' : err.message); }
  let mode = 'replace';
  if (hasData()) {
    mode = await choose('백업 파일을 어떻게 불러올까요?\n· 합치기: 같은 항목은 더 최근에 수정한 쪽을 남김\n· 전체 바꾸기: 파일에 든 종류(자금·평면도 등)의 지금 데이터를 지우고 파일 내용으로 교체',
      [{ label: '합치기', value: 'merge', cls: 'pri' }, { label: '전체 바꾸기', value: 'replace', cls: 'danger' }, { label: '취소', value: '' }]);
    if (!mode) return;
  }
  const n = await importData(o, mode);
  toast(`${n}개 항목을 불러왔어요`); render();
});

/* ---------- 하단 시트 ---------- */
let sheetOnClose = null, afterPop = null;
function showSheet(html) {
  sheet.innerHTML = html; sheet.onclick = null; sheet.scrollTop = 0;
  if (sheet.hidden) { sheet.hidden = false; sheetBg.hidden = false; history.pushState({ sheet: 1 }, ''); }
}
function hideSheet() {
  sheet.hidden = true; sheetBg.hidden = true;
  const cb = sheetOnClose; sheetOnClose = null; if (cb) cb('');
}
function closeSheet() {
  return new Promise(res => {
    if (sheet.hidden) return res();
    if (history.state && history.state.sheet) { afterPop = res; history.back(); } else { hideSheet(); res(); }
  });
}
window.addEventListener('popstate', () => { hideSheet(); if (afterPop) { const f = afterPop; afterPop = null; f(); } });
sheetBg.addEventListener('click', () => closeSheet());
function choose(msg, opts) {
  return new Promise(res => {
    showSheet(`<p>${h(msg)}</p>` + opts.map(o => `<button class="btn ${o.cls || ''}" data-v="${h(o.value)}">${h(o.label)}</button>`).join(''));
    sheetOnClose = res;
    sheet.onclick = async e => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      sheetOnClose = null; const v = b.dataset.v; await closeSheet(); res(v);
    };
  });
}
const ask = async (msg, ok = '확인', cls = 'pri') => (await choose(msg, [{ label: ok, value: 'y', cls }, { label: '취소', value: '' }])) === 'y';

function openForm({ title, fields, value, raw, intro, onSave, onDelete }) {
  const v = value || {};
  // intro: 이 파일 안에서 h()로 escape해 만든 HTML만 넘긴다
  let html = `<h3>${h(title)}</h3>` + (raw ? `<div class="raw">원문: ${h(raw)}</div>` : '') + (intro || '');
  for (const f of fields) {
    const val = v[f.key] ?? '';
    if (f.type === 'check') html += `<label class="f ck"><input type="checkbox" data-k="${f.key}" ${val ? 'checked' : ''}><span>${h(f.label)}</span></label>`;
    else if (f.type === 'select') html += `<label class="f"><span>${h(f.label)}</span><select data-k="${f.key}">${f.options.map(o => typeof o === 'string' ? { v: o, l: o } : o)
      .map(o => `<option value="${h(o.v)}" ${String(o.v) === String(val) ? 'selected' : ''}>${h(o.l)}</option>`).join('')}</select></label>`;
    else if (f.type === 'decimal') html += `<label class="f"><span>${h(f.label)}</span><input type="number" inputmode="decimal" step="0.01" data-k="${f.key}" value="${h(val)}" placeholder="${h(f.ph || '')}"></label>`;
    else if (f.type === 'textarea') html += `<label class="f"><span>${h(f.label)}</span><textarea data-k="${f.key}">${h(val)}</textarea></label>`;
    else if (f.type === 'money') html += `<label class="f"><span>${h(f.label)} (만원)</span><input type="number" inputmode="decimal" step="any" data-k="${f.key}" data-money value="${h(val)}" placeholder="예: 3100"><div class="hint"></div></label>`;
    else html += `<label class="f"><span>${h(f.label)}</span><input type="${f.type || 'text'}" data-k="${f.key}" value="${h(val)}" placeholder="${h(f.ph || '')}"></label>`;
  }
  html += `<div class="acts">${onDelete ? '<button class="btn danger" data-a="del">삭제</button>' : ''}<button class="btn" data-a="cancel">취소</button><button class="btn pri" data-a="save">저장</button></div>`;
  showSheet(html);
  sheet.querySelectorAll('[data-money]').forEach(inp => {
    const hint = inp.nextElementSibling, up = () => hint.textContent = inp.value === '' ? '비워 두면 미정' : '= ' + won(inp.value);
    inp.addEventListener('input', up); up();
  });
  sheet.onclick = async e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'cancel') return closeSheet();
    if (a === 'del') { if (await ask('이 항목을 삭제할까요?', '삭제', 'danger')) { await onDelete(); render(); toast('삭제했어요'); } return; }
    const out = { ...v };
    for (const f of fields) {
      const el = sheet.querySelector(`[data-k="${f.key}"]`);
      out[f.key] = f.type === 'check' ? el.checked : f.type === 'money' || f.type === 'decimal' ? (el.value === '' ? null : Number(el.value)) : el.value.trim();
    }
    if (!out.name) return toast('이름을 입력하세요');
    await onSave(out); await closeSheet(); render();
  };
}
const CHECKF = [{ key: 'needsCheck', label: '확인 필요로 표시', type: 'check' }, { key: 'checkNote', label: '확인할 내용' }];

/* ---------- 편집기 ---------- */
function editScenario(r) {
  openForm({
    title: r ? '시나리오 수정' : '시나리오 추가', value: r, raw: r?.raw,
    fields: [{ key: 'name', label: '이름', ph: '예: 자금 현황' }, { key: 'note', label: '메모', type: 'textarea' }, ...CHECKF],
    onSave: async o => { await put('scenarios', o); await setMeta('activeScenario', o.id); },
    onDelete: r && (async () => {
      const ids = S.budgets.filter(b => b.scenario === r.id).map(b => b.id);
      await tx(['budgets', 'scenarios'], t => { ids.forEach(i => t.objectStore('budgets').delete(i)); t.objectStore('scenarios').delete(r.id); });
      await loadAll();
    }),
  });
}
function editBudget(r, init) {
  const v = r || init, isCost = v.kind === 'cost';
  openForm({
    title: (isCost ? '비용' : '재원') + (r ? ' 수정' : ' 추가'), value: v, raw: r?.raw,
    fields: [{ key: 'name', label: '항목', ph: isCost ? '예: 취득세' : '예: 회사대출' }, { key: 'amount', label: isCost ? '예산' : '금액', type: 'money' },
      ...(isCost ? [{ key: 'paid', label: '실제 지출', type: 'money' }] : []), { key: 'note', label: '메모', type: 'textarea' }, ...CHECKF],
    onSave: o => put('budgets', o), onDelete: r && (() => del('budgets', r.id)),
  });
}
function editPayment(r) {
  openForm({
    title: r ? '지급 수정' : '지급 추가', value: r || { when: '잔금 전', cat: '매매', done: false }, raw: r?.raw,
    fields: [{ key: 'name', label: '항목', ph: '예: 계약금' }, { key: 'amount', label: '금액', type: 'money' },
      { key: 'when', label: '시점', type: 'select', options: WHENS }, { key: 'cat', label: '분류', type: 'select', options: PAYCATS },
      { key: 'date', label: '날짜', type: 'date' }, { key: 'done', label: '지급 완료', type: 'check' },
      { key: 'source', label: '돈 나오는 곳', ph: '예: 회사대출' }, { key: 'note', label: '메모', type: 'textarea' }, ...CHECKF],
    onSave: o => put('payments', o), onDelete: r && (() => del('payments', r.id)),
  });
}
function editItem(r) {
  openForm({
    title: r ? '품목 수정' : '품목 추가', value: r || { cat: ITEMCATS.includes(UI.itemCat) ? UI.itemCat : '가전', status: '검토중' }, raw: r?.raw,
    fields: [{ key: 'name', label: '이름', ph: '예: 냉장고 / 욕실 공사' }, { key: 'cat', label: '분류', type: 'select', options: ITEMCATS },
      { key: 'status', label: '상태', type: 'select', options: STATUSES }, { key: 'brand', label: '브랜드·업체' }, { key: 'model', label: '모델·내용' },
      { key: 'budget', label: '예산', type: 'money' }, { key: 'price', label: '실제 금액', type: 'money' },
      { key: 'shop', label: '구매처' }, ...roomField(r?.room), { key: 'url', label: '링크', type: 'url', ph: 'https://' }, { key: 'note', label: '메모', type: 'textarea' }, ...CHECKF],
    onSave: o => put('items', o), onDelete: r && (() => del('items', r.id)),
  });
}
// 품목 ↔ 방 연결: 지금 보고 있는 평면도의 방 목록에서 고른다
function roomField(cur) {
  const p = plan(); if (!p && !cur) return [];
  const opts = [{ v: '', l: '선택 안 함' }, ...(p?.rooms || []).map(x => ({ v: x.id, l: x.name }))];
  if (cur && !opts.some(o => o.v === cur)) opts.push({ v: cur, l: (findRoom(cur)?.name || '삭제된 방') + ' (다른 평면도)' });
  return [{ key: 'room', label: '설치할 방', type: 'select', options: opts }];
}
// 북쪽 방향: '위에서' 화면의 위쪽에서 시계 방향으로 잰 각도(도). 비어 있으면 나침반을 그리지 않는다
const NORTHS = [['', '표시 안 함'], [0, '위쪽 ↑'], [45, '오른쪽 위 ↗'], [90, '오른쪽 →'], [135, '오른쪽 아래 ↘'], [180, '아래쪽 ↓'], [225, '왼쪽 아래 ↙'], [270, '왼쪽 ←'], [315, '왼쪽 위 ↖']];
const hasNorth = p => p?.north != null && p.north !== '' && isFinite(p.north);
function editPlan(r) {
  const opts = NORTHS.map(([v, l]) => ({ v, l }));
  if (hasNorth(r) && !opts.some(o => String(o.v) === String(r.north))) opts.push({ v: r.north, l: r.north + '°' });
  openForm({
    title: '평면도 정보 수정', value: r,
    fields: [{ key: 'name', label: '이름' }, { key: 'area', label: '전용면적 (㎡, 서류 기준)', type: 'decimal' },
      { key: 'north', label: "북쪽 방향 ('위에서' 화면 기준)", type: 'select', options: opts },
      { key: 'note', label: '메모', type: 'textarea' }, ...CHECKF],
    onSave: async o => { o.north = o.north === '' ? null : Number(o.north); await put('plans', o); await setMeta('activePlan', o.id); },
    onDelete: async () => { await del('plans', r.id); UI.room = null; },
  });
}
function editRoom(p, r) {
  const its = S.items.filter(i => i.room === r.id);
  openForm({
    title: '방 정보', value: r,
    intro: `<div class="raw">도면 추정 ${m2s(r.est)} (${py(r.est)}평) · ${h(rDims(r))}<br>치수 없는 도면을 전용면적에 맞춰 계산한 값이에요. 실측하면 아래에 넣으세요.</div>`
      + (its.length ? `<div class="sub" style="margin-bottom:12px">연결된 품목: ${its.map(i => h(i.name)).join(', ')}</div>` : ''),
    fields: [{ key: 'name', label: '이름' }, { key: 'm2', label: '실측 면적 (㎡) — 비우면 추정값', type: 'decimal', ph: '예: 15.2' },
      { key: 'note', label: '메모', type: 'textarea' }, ...CHECKF],
    onSave: o => put('plans', { ...p, rooms: p.rooms.map(x => x.id === r.id ? o : x) }),
  });
}
const EDIT = { scenarios: editScenario, budgets: editBudget, payments: editPayment, items: editItem, plans: editPlan };

/* ---------- 화면 ---------- */
const scen = () => S.scenarios.find(s => s.id === S.meta.activeScenario) || S.scenarios[0];
function totals(id) {
  const c = S.budgets.filter(b => b.scenario === id && b.kind === 'cost'), f = S.budgets.filter(b => b.scenario === id && b.kind === 'fund');
  return { c, f, cost: sum(c), fund: sum(f), paid: sum(c, 'paid') };
}
const warn = r => r.needsCheck ? '<span class="tag warn">확인 필요</span>' : '';
const stTag = s => `<span class="tag s${STATUSES.indexOf(s) + 1}">${h(s)}</span>`;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;

function payRow(p) {
  return `<div class="row ${p.done ? 'done' : ''}" data-act="edit" data-store="payments" data-id="${h(p.id)}">
    <button class="chk ${p.done ? 'on' : ''}" data-act="toggle" data-id="${h(p.id)}" aria-label="지급 완료">✓</button>
    <div class="mid"><div class="nm">${h(p.name)}</div><div class="sub"><span class="tag">${h(p.cat || '기타')}</span>${warn(p)}${p.date ? h(p.date) + ' · ' + dday(p.date) : ''}${p.source ? ' ' + h(p.source) : ''}</div></div>
    <div class="amt">${won(p.amount)}</div></div>`;
}

function vHome() {
  if (!hasData()) return `<div class="card"><h2>환영해요 👋</h2>
    <p class="sub">집 매매 자금, 지급 일정, 인테리어·가전·가구 구매를 한곳에서 관리해요. 데이터는 이 폰에만 저장돼요.</p>
    <button class="btn pri" data-act="import">백업 파일 불러오기</button><button class="btn" data-act="blank">빈 상태로 시작</button></div>` + installBanner();
  let o = installBanner();
  const base = S.meta.lastBackup || S.meta.firstUse || Date.now();
  if (Date.now() - base > 14 * DAY) o += `<div class="banner"><b>백업한 지 2주가 넘었어요.</b> 폰을 바꾸거나 브라우저 데이터를 지우면 사라지니 백업해 두세요.<button class="btn sm pri" data-act="export" style="margin-top:8px">지금 백업</button></div>`;
  const sc = scen();
  if (sc) {
    const t = totals(sc.id), gap = t.cost - t.fund;
    o += `<div class="card"><h2>자금 <small>${h(sc.name)}</small></h2><div class="sub">총 비용</div><div class="big">${won(t.cost)}</div>
      <div class="bar"><i class="g" style="width:${pct(t.fund, t.cost)}%"></i></div>
      <div class="kv"><span>마련된 재원</span><b>${won(t.fund)}</b></div>
      <div class="kv"><span>${gap > 0 ? '필요한 금액 (부족)' : '여유'}</span><b class="${gap > 0 ? 'bad' : 'ok'}">${won(Math.abs(gap))}</b></div>
      <div class="kv"><span>실제 지출</span><b>${won(t.paid)} <span class="sub">(${pct(t.paid, t.cost)}%)</span></b></div></div>`;
  }
  const un = S.payments.filter(p => !p.done), before = un.filter(p => p.when === '잔금 전');
  const next = [...un].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.order - b.order).slice(0, 3);
  o += `<div class="card"><h2>지급 <small>완료 ${S.payments.length - un.length}/${S.payments.length}</small></h2>
    <div class="sub">잔금 전 필요한 금액 (남은 것)</div><div class="big acc">${won(sum(before))}</div>
    <div class="kv"><span>남은 지급 전체</span><b>${won(sum(un))}</b></div>
    ${next.map(payRow).join('') || '<div class="empty">남은 지급이 없어요</div>'}</div>`;
  o += `<div class="card"><h2>구매·공사</h2>${ITEMCATS.map(c => { const a = S.items.filter(i => i.cat === c); return `<div class="kv"><span>${c}</span><b>완료 ${a.filter(i => i.status === '완료').length}/${a.length} <span class="sub">· ${won(sum(a, 'price'))}</span></b></div>`; }).join('')}</div>`;
  const chk = STORES.flatMap(s => S[s].filter(r => r.needsCheck).map(r => ({ s, r })));
  if (chk.length) o += `<div class="card"><h2>확인 필요 <small>${chk.length}건</small></h2>${chk.map(({ s, r }) =>
    `<div class="row" data-act="edit" data-store="${s}" data-id="${h(r.id)}"><div class="mid"><div class="nm">${h(r.name)}</div><div class="sub">${h(r.checkNote || '')}</div></div></div>`).join('')}</div>`;
  return o;
}
function installBanner() {
  if (standalone()) return '';
  return `<div class="banner"><b>홈 화면에 설치</b>하면 앱처럼 쓸 수 있어요. ` + (installEvt
    ? `<button class="btn sm pri" data-act="install" style="margin-top:8px">설치</button>`
    : `메뉴(⋮) → 'Chrome에서 열기' → '홈 화면에 추가' → '설치'`) + `</div>`;
}

function budRow(b) {
  return `<div class="row" data-act="edit" data-store="budgets" data-id="${h(b.id)}"><div class="mid"><div class="nm">${h(b.name)}</div>
    ${b.needsCheck || b.note ? `<div class="sub">${warn(b)}${h(b.note || '')}</div>` : ''}</div>
    <div class="amt">${won(b.amount)}${b.kind === 'cost' && b.paid ? `<small>지출 ${won(b.paid)}</small>` : ''}</div></div>`;
}
function vMoney() {
  const sc = scen();
  let o = `<div class="chips">${S.scenarios.map(s => `<button class="chip ${sc && s.id === sc.id ? 'on' : ''}" data-act="scen" data-id="${h(s.id)}">${h(s.name)}</button>`).join('')}<button class="chip" data-act="scen-add">＋ 시나리오</button></div>`;
  if (!sc) return o + `<div class="empty">시나리오를 추가해서 비용과 재원을 정리하세요</div>`;
  const t = totals(sc.id), gap = t.cost - t.fund;
  o += `<div class="card"><h2>결과 <button class="add" data-act="edit" data-store="scenarios" data-id="${h(sc.id)}">시나리오 수정</button></h2>
    <div class="kv"><span>총 비용</span><b>${won(t.cost)}</b></div><div class="kv"><span>재원 합계</span><b>${won(t.fund)}</b></div>
    <div class="kv"><span>${gap > 0 ? '필요한 금액 (부족)' : '여유'}</span><b class="big ${gap > 0 ? 'bad' : 'ok'}">${won(Math.abs(gap))}</b></div>
    <div class="bar"><i style="width:${pct(t.paid, t.cost)}%"></i></div><div class="sub">실제 지출 ${won(t.paid)} / 예산의 ${pct(t.paid, t.cost)}%</div>
    ${sc.note || sc.needsCheck ? `<div class="sub" style="margin-top:8px">${warn(sc)}${h(sc.note || '')}${sc.needsCheck && sc.checkNote ? '<br>' + h(sc.checkNote) : ''}</div>` : ''}</div>`;
  o += `<div class="card"><h2>비용 <button class="add" data-act="bud-add" data-kind="cost">＋ 추가</button></h2>${t.c.map(budRow).join('') || '<div class="empty">비용 항목이 없어요</div>'}<div class="sum"><span>합계</span><span>${won(t.cost)}</span></div></div>`;
  o += `<div class="card"><h2>재원 <button class="add" data-act="bud-add" data-kind="fund">＋ 추가</button></h2>${t.f.map(budRow).join('') || '<div class="empty">재원 항목이 없어요</div>'}<div class="sum"><span>합계</span><span>${won(t.fund)}</span></div></div>`;
  return o;
}
function vPay() {
  const done = S.payments.filter(p => p.done);
  let o = `<div class="card"><h2>지급 계획 <small>완료 ${done.length}/${S.payments.length}</small></h2>
    <div class="kv"><span>전체</span><b>${won(sum(S.payments))}</b></div><div class="kv"><span>지급 완료</span><b class="ok">${won(sum(done))}</b></div>
    <div class="kv"><span>남음</span><b class="acc">${won(sum(S.payments) - sum(done))}</b></div>
    <div class="bar"><i class="g" style="width:${pct(sum(done), sum(S.payments))}%"></i></div></div>`;
  for (const w of WHENS) {
    const a = S.payments.filter(p => (WHENS.includes(p.when) ? p.when : '미정') === w);
    if (a.length) o += `<div class="card"><h2>${w} <small>${won(sum(a))} · 남음 ${won(sum(a.filter(p => !p.done)))}</small></h2>${a.map(payRow).join('')}</div>`;
  }
  if (!S.payments.length) o += `<div class="empty">오른쪽 위 '＋ 추가'로 지급 일정을 넣으세요</div>`;
  return o;
}
function itemList() {
  const rn = i => findRoom(i.room)?.name || '';
  const a = S.items.filter(i => (UI.itemCat === '전체' || i.cat === UI.itemCat) && (!UI.q || match([i.name, i.brand, i.model, i.shop, i.note, i.cat, i.status, rn(i)].join(' '), UI.q)));
  const rows = a.map(i => `<div class="row" data-act="edit" data-store="items" data-id="${h(i.id)}"><div class="mid"><div class="nm">${h(i.name)}</div>
    <div class="sub">${stTag(i.status)}<span class="tag">${h(i.cat)}</span>${rn(i) ? `<span class="tag">📍${h(rn(i))}</span>` : ''}${warn(i)}${h([i.brand, i.model].filter(Boolean).join(' '))}${/^https?:\/\//i.test(i.url || '') ? ` <a href="${h(i.url)}" target="_blank" rel="noopener" data-act="link">🔗링크</a>` : ''}</div></div>
    <div class="amt">${i.price != null ? won(i.price) : won(i.budget)}<small>${i.price != null ? '실제' : i.budget != null ? '예산' : ''}</small></div></div>`).join('');
  return `<div class="card">${rows || '<div class="empty">항목이 없어요</div>'}
    <div class="sum"><span>예산 합계</span><span>${won(sum(a, 'budget'))}</span></div><div class="sum" style="border:0;padding-top:4px"><span>실제 금액 합계</span><span>${won(sum(a, 'price'))}</span></div></div>`;
}
function vItems() {
  return `<div class="chips">${['전체', ...ITEMCATS].map(c => `<button class="chip ${UI.itemCat === c ? 'on' : ''}" data-act="icat" data-id="${c}">${c} ${c === '전체' ? S.items.length : S.items.filter(i => i.cat === c).length}</button>`).join('')}</div>
    <input class="search" id="q" type="search" placeholder="검색 (초성 가능: ㄴㅈㄱ)" value="${h(UI.q)}"><div id="ilist">${itemList()}</div>`;
}
function vMore() {
  const lb = S.meta.lastBackup;
  return `<div class="card"><h2>백업</h2><div class="sub">마지막 백업: ${lb ? new Date(lb).toLocaleDateString('ko-KR') : '없음'}</div>
    <button class="btn pri" data-act="export">백업 파일 내보내기</button><button class="btn" data-act="share">백업 파일 공유 (카톡 등)</button>
    <button class="btn" data-act="import">백업 파일 불러오기</button></div>
    <div class="card"><h2>저장공간</h2><div class="sub" id="persist">확인 중…</div><button class="btn" data-act="persist">저장공간 보호 요청</button></div>
    <div class="card"><h2>데이터</h2><div class="sub">시나리오 ${S.scenarios.length} · 비용/재원 ${S.budgets.length} · 지급 ${S.payments.length} · 구매·공사 ${S.items.length} · 평면도 ${S.plans.length}</div>
    <button class="btn danger" data-act="wipe">전체 삭제</button></div>
    <div class="sub" style="text-align:center">우리집노트 v${APP_VERSION} · 데이터는 이 기기에만 저장돼요</div>`;
}
/* ---------- 평면도 (3D) ---------- */
// 방 데이터 {id, name, kind, pts:[[x,y]…](m, 벽 중심선), est(도면 추정 ㎡), m2(실측 ㎡, 없으면 null)} — 사용자 데이터로만 들어온다
const plan = () => S.plans.find(p => p.id === S.meta.activePlan) || S.plans[0];
const findRoom = id => id ? S.plans.flatMap(p => p.rooms || []).find(r => r.id === id) : null;
const measured = r => r.m2 != null && r.m2 !== '';
const rArea = r => measured(r) ? Number(r.m2) : Number(r.est) || 0;
const m2s = m => (Math.round(m * 10) / 10).toFixed(1) + '㎡';
const py = m => (m / 3.3058).toFixed(1);
function rDims(r) {
  if (!Array.isArray(r.pts) || r.pts.length < 3) return '모양 정보 없음';
  const xs = r.pts.map(p => p[0]), ys = r.pts.map(p => p[1]);
  return (r.pts.length > 4 ? '최대 ' : '약 ') + (Math.max(...xs) - Math.min(...xs)).toFixed(1) + ' × ' + (Math.max(...ys) - Math.min(...ys)).toFixed(1) + 'm';
}
function inPoly(x, y, poly) {
  let o = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) o = !o;
  }
  return o;
}
const LP = new WeakMap();
function labelPt(r) { // 방 안에서 벽과 가장 먼 점 (ㄱ자 방도 글자가 방 안에 오게)
  if (LP.has(r)) return LP.get(r);
  const xs = r.pts.map(p => p[0]), ys = r.pts.map(p => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, d = Math.max(...ys) - y0;
  let best = [x0 + w / 2, y0 + d / 2], bd = -1;
  for (let i = 1; i < 16; i++) for (let j = 1; j < 16; j++) {
    const x = x0 + w * i / 16, y = y0 + d * j / 16; if (!inPoly(x, y, r.pts)) continue;
    let m = 1e9;
    r.pts.forEach((a, k) => { const b = r.pts[(k + 1) % r.pts.length], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)); m = Math.min(m, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)); });
    if (m > bd) { bd = m; best = [x, y]; }
  }
  LP.set(r, best); return best;
}
function roomRow(r) {
  const n = S.items.filter(i => i.room === r.id).length;
  return `<div class="row" data-act="room" data-id="${h(r.id)}"><span class="sw" style="background:${(KINDS[r.kind] || KINDS.room)[1]}"></span>
    <div class="mid"><div class="nm">${h(r.name)}</div><div class="sub">${warn(r)}${h(rDims(r))}${n ? ` · 품목 ${n}` : ''}</div></div>
    <div class="amt">${m2s(rArea(r))}<small>${py(rArea(r))}평 · ${measured(r) ? '실측' : '추정'}</small></div></div>`;
}
function roomInfo() {
  const p = plan(), r = p?.rooms?.find(x => x.id === UI.room);
  if (!r) return '<div class="sub">방을 누르면 면적과 연결된 품목이 나와요</div>';
  const its = S.items.filter(i => i.room === r.id);
  return `<div class="rinfo"><div class="mid"><b>${h(r.name)}</b> ${m2s(rArea(r))} <span class="sub">(${py(rArea(r))}평 · ${measured(r) ? '실측' : '추정'})</span>
    <div class="sub">${h(rDims(r))}${its.length ? ' · ' + its.map(i => h(i.name)).join(', ') : ''}</div></div>
    <button class="btn sm" data-act="room" data-id="${h(r.id)}">수정</button></div>`;
}
function vPlan() {
  const p = plan();
  if (!p) return `<div class="card"><h2>평면도</h2><div class="empty">평면도 데이터가 없어요.<br>평면도 파일을 '백업 파일 불러오기'로 넣으세요.</div>
    <button class="btn pri" data-act="import">백업 파일 불러오기</button></div>`;
  const rooms = p.rooms || [], inn = rooms.filter(r => r.kind !== 'balcony'), bal = rooms.filter(r => r.kind === 'balcony');
  const ai = inn.reduce((t, r) => t + rArea(r), 0), ab = bal.reduce((t, r) => t + rArea(r), 0);
  let o = S.plans.length > 1 ? `<div class="chips">${S.plans.map(x => `<button class="chip ${x.id === p.id ? 'on' : ''}" data-act="plan" data-id="${h(x.id)}">${h(x.name)}</button>`).join('')}</div>` : '';
  o += `<div class="card"><h2>${h(p.name)} <button class="add" data-act="edit" data-store="plans" data-id="${h(p.id)}">수정</button></h2>
    ${p.needsCheck ? `<div class="sub" style="margin-bottom:8px">${warn(p)}${h(p.checkNote || '')}</div>` : ''}
    <div class="cv-wrap"><canvas id="cv" aria-label="3D 평면도"></canvas>
      <div class="cv-btns"><button class="chip" data-act="cam" data-id="3d">3D</button><button class="chip" data-act="cam" data-id="top">위에서</button></div></div>
    <div class="sub cv-hint">한 손가락: 돌리기·기울이기 · 두 손가락: 확대</div><div id="rinfo">${roomInfo()}</div></div>`;
  o += `<div class="card"><h2>면적 <small>${rooms.some(r => !measured(r)) ? '도면 추정 포함' : '실측'}</small></h2>
    <div class="kv"><span>전용면적 (서류)</span><b>${p.area ? m2s(p.area) + ' · ' + py(p.area) + '평' : '미정'}</b></div>
    <div class="kv"><span>실내 합계 (방·거실·욕실 등)</span><b>${m2s(ai)} · ${py(ai)}평</b></div>
    <div class="kv"><span>발코니 합계 (서비스 면적)</span><b>${m2s(ab)} · ${py(ab)}평</b></div>
    ${p.note ? `<div class="sub" style="margin-top:6px">${h(p.note)}</div>` : ''}</div>`;
  o += `<div class="card"><h2>공간별 면적 <small>${rooms.length}곳</small></h2>${[...inn, ...bal].map(roomRow).join('')}</div>`;
  return o;
}
let HIT = [], NDIR = null, rafId = 0; // NDIR: 나침반 N이 가리키는 화면 방향(단위 벡터, 테스트용)
const reqDraw = () => { if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; drawPlan(); }); };
function drawPlan() {
  const cv = $('#cv'), p = plan(); if (!cv || !p) return;
  const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const rooms = (p.rooms || []).filter(r => Array.isArray(r.pts) && r.pts.length > 2); if (!rooms.length) return;
  const all = rooms.flatMap(r => r.pts), xs = all.map(q => q[0]), ys = all.map(q => q[1]);
  const mx = (Math.min(...xs) + Math.max(...xs)) / 2, mz = (Math.min(...ys) + Math.max(...ys)) / 2;
  const { yaw, pitch, zoom } = UI.cam, cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), WALL = 1.1;
  const raw = (x, z, y = 0) => { const X = x - mx, Z = z - mz, x1 = X * cy - Z * sy, z1 = X * sy + Z * cy; return [x1, z1 * sp - y * cp, z1 * cp + y * sp]; };
  // 지금 각도에서 보이는 크기에 맞춰 화면을 채움 (벽 윗면 포함)
  const pr = all.flatMap(q => [raw(q[0], q[1]), raw(q[0], q[1], WALL)]), us = pr.map(v => v[0]), vs = pr.map(v => v[1]);
  const u0 = (Math.min(...us) + Math.max(...us)) / 2, v0 = (Math.min(...vs) + Math.max(...vs)) / 2;
  const k = Math.min((W - 16) / (Math.max(...us) - Math.min(...us)), (H - 44) / (Math.max(...vs) - Math.min(...vs))) * zoom;
  const P = (x, z, y = 0) => { const [u, v, d] = raw(x, z, y); return [W / 2 + (u - u0) * k, H / 2 + 6 + (v - v0) * k, d]; };
  const path = a => { g.beginPath(); a.forEach((q, i) => i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.closePath(); };
  // 1) 바닥
  HIT = [];
  for (const r of rooms) {
    const poly = r.pts.map(q => P(q[0], q[1])); HIT.push({ id: r.id, poly });
    path(poly); g.fillStyle = r.id === UI.room ? '#ffb048' : (KINDS[r.kind] || KINDS.room)[1]; g.fill();
    g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1; g.stroke();
  }
  // 2) 벽 (방 테두리를 세움, 겹치는 변은 한 번만, 먼 것부터)
  const E = new Map();
  for (const r of rooms) r.pts.forEach((a, i) => {
    const b = r.pts[(i + 1) % r.pts.length], key = [a, b].map(q => q.map(v => v.toFixed(2)).join(',')).sort().join('|');
    const ht = r.kind === 'balcony' ? WALL * 0.45 : WALL, e = E.get(key);
    if (!e || e.ht < ht) E.set(key, { a, b, ht });
  });
  const faces = [...E.values()].map(({ a, b, ht }) => {
    const q = [P(a[0], a[1]), P(b[0], b[1]), P(b[0], b[1], ht), P(a[0], a[1], ht)];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1, lit = 0.55 + 0.45 * Math.abs((-dz * 0.6 + dx * 0.8) / L);
    return { q, d: q.reduce((t, v) => t + v[2], 0) / 4, lit, low: ht < WALL };
  }).sort((u, v) => u.d - v.d);
  for (const f of faces) {
    path(f.q); const c = f.low ? [150, 160, 180] : [222, 227, 238];
    g.fillStyle = `rgba(${c.map(v => Math.round(v * f.lit)).join(',')},${f.low ? 0.75 : 0.93})`; g.fill();
    g.strokeStyle = 'rgba(20,25,35,.55)'; g.lineWidth = 0.8; g.stroke();
  }
  // 3) 이름·면적 글자 — 고른 방 → 실내 큰 방 → 발코니 순으로, 겹치면 ㎡만, 그래도 겹치면 생략(누르면 정보가 나옴)
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const boxes = [], hitB = b => boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
  const ord = [...rooms].sort((p1, p2) => (p2.id === UI.room) - (p1.id === UI.room) || (p1.kind === 'balcony') - (p2.kind === 'balcony') || rArea(p2) - rArea(p1));
  for (const r of ord) {
    const [lx, lz] = labelPt(r), [sx, sy2] = P(lx, lz, 0.02), bal = r.kind === 'balcony', sel = r.id === UI.room;
    const t2 = m2s(rArea(r)) + (measured(r) ? '' : '*');
    const tries = bal ? [['', t2]] : [[r.name, t2], ['', t2]];
    for (const [t1, tt] of tries) {
      g.font = '700 11px system-ui,sans-serif'; const w1 = t1 ? g.measureText(t1).width : 0;
      g.font = `${t1 ? 10 : 9}px system-ui,sans-serif`; const w = Math.max(w1, g.measureText(tt).width) + 8, hh = t1 ? 28 : 15;
      const b = [sx - w / 2, sy2 - hh / 2, sx + w / 2, sy2 + hh / 2];
      if (!sel && hitB(b)) continue;
      boxes.push(b);
      g.fillStyle = sel ? 'rgba(27,19,5,.88)' : 'rgba(10,13,20,.62)';
      g.beginPath(); g.roundRect ? g.roundRect(b[0], b[1], w, hh, 5) : g.rect(b[0], b[1], w, hh); g.fill();
      if (t1) { g.font = '700 11px system-ui,sans-serif'; g.fillStyle = '#fff'; g.fillText(t1, sx, sy2 - 6);
        g.font = '10px system-ui,sans-serif'; g.fillStyle = '#ffd08a'; g.fillText(tt, sx, sy2 + 7); }
      else { g.font = '9px system-ui,sans-serif'; g.fillStyle = bal ? '#c7cede' : '#ffd08a'; g.fillText(tt, sx, sy2); }
      break;
    }
  }
  // 4) 나침반 — 도면의 북쪽(위쪽 기준 시계 방향 north°)을 지금 카메라 각도로 투영해서 그림
  NDIR = null;
  if (hasNorth(p)) {
    const t = Number(p.north) * Math.PI / 180, a = P(mx, mz), b = P(mx + Math.sin(t), mz - Math.cos(t));
    let dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy);
    if (L > 1e-6) {
      dx /= L; dy /= L; NDIR = [dx, dy]; const R = 17, cx = W - R - 9, cy2 = H - R - 9;
      g.beginPath(); g.arc(cx, cy2, R, 0, Math.PI * 2); g.fillStyle = 'rgba(10,13,20,.7)'; g.fill();
      g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 1; g.stroke();
      const tri = (s, col) => { g.beginPath(); g.moveTo(cx + dx * s * (R - 4), cy2 + dy * s * (R - 4));
        g.lineTo(cx - dy * 4, cy2 + dx * 4); g.lineTo(cx + dy * 4, cy2 - dx * 4); g.closePath(); g.fillStyle = col; g.fill(); };
      tri(-1, '#8b93a7'); tri(1, '#ff5a5a');
      g.font = '700 10px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
      const lx = cx + dx * (R + 7), ly = cy2 + dy * (R + 7);
      g.fillText('N', Math.min(W - 6, Math.max(6, lx)), Math.min(H - 6, Math.max(6, ly)));
    }
  }
  g.textAlign = 'left'; g.font = '10px system-ui,sans-serif'; g.fillStyle = '#98a2b8';
  g.fillText(rooms.some(r => !measured(r)) ? '* 도면 추정치' : '', 8, H - 10);
}
function bindCanvas() {
  const cv = $('#cv'); if (!cv || cv.dataset.bound) return; cv.dataset.bound = 1;
  const pts = new Map(); let start = null, moved = false, pin = null;
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; };
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture?.(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1) { start = [e.clientX, e.clientY]; moved = false; }
    if (pts.size === 2) { pin = { d: dist(), z: UI.cam.zoom }; moved = true; }
  });
  cv.addEventListener('pointermove', e => {
    const prev = pts.get(e.pointerId); if (!prev) return;
    const cur = [e.clientX, e.clientY]; pts.set(e.pointerId, cur);
    if (pts.size === 1) {
      if (Math.hypot(cur[0] - start[0], cur[1] - start[1]) > 6) moved = true;
      if (moved) { UI.cam.yaw += (cur[0] - prev[0]) * 0.01; UI.cam.pitch = cl(UI.cam.pitch + (cur[1] - prev[1]) * 0.008, 0.35, Math.PI / 2); reqDraw(); }
    } else if (pin) { UI.cam.zoom = cl(pin.z * dist() / pin.d, 0.6, 3); reqDraw(); }
  });
  const end = e => {
    if (!pts.delete(e.pointerId)) return; if (pts.size < 2) pin = null;
    if (e.type === 'pointerup' && !moved && !pts.size) {
      const b = cv.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
      const hit = HIT.find(t => inPoly(x, y, t.poly)); UI.room = hit && hit.id !== UI.room ? hit.id : null;
      $('#rinfo').innerHTML = roomInfo(); drawPlan();
    }
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('wheel', e => { e.preventDefault(); UI.cam.zoom = cl(UI.cam.zoom * (e.deltaY < 0 ? 1.1 : 0.9), 0.6, 3); reqDraw(); }, { passive: false });
}
window.addEventListener('resize', () => route() === 'plan' && reqDraw());

const VIEWS = { home: ['우리집노트', vHome], money: ['자금', vMoney], pay: ['지급 일정', vPay], items: ['구매·공사', vItems], plan: ['평면도', vPlan], more: ['설정', vMore] };
function route() { const r = location.hash.replace(/^#\//, ''); return VIEWS[r] ? r : 'home'; }
function render() {
  const r = route(), [title, fn] = VIEWS[r];
  $('#title').textContent = title;
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === r));
  $('#topact').innerHTML = r === 'pay' || r === 'items' ? '<button data-act="top-add">＋ 추가</button>' : '';
  const y = scrollY; view.innerHTML = fn(); scrollTo(0, y);
  if (r === 'plan') { bindCanvas(); drawPlan(); }
  if (r === 'more' && navigator.storage?.persisted) navigator.storage.persisted().then(p => { const el = $('#persist'); if (el) el.textContent = p ? '보호됨 — 브라우저가 임의로 지우지 않아요' : '보호 안 됨 — 저장공간이 부족하면 지워질 수 있어요'; });
}
window.addEventListener('hashchange', () => { scrollTo(0, 0); render(); });

/* ---------- 이벤트 ---------- */
$('#topact').addEventListener('click', () => route() === 'pay' ? editPayment() : editItem());
view.addEventListener('input', e => { if (e.target.id === 'q') { UI.q = e.target.value; $('#ilist').innerHTML = itemList(); } });
view.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act, id = el.dataset.id;
  if (a === 'link') return;
  if (a === 'toggle') { const p = S.payments.find(x => x.id === id); await put('payments', { ...p, done: !p.done }); return render(); }
  if (a === 'edit') { const r = S[el.dataset.store].find(x => x.id === id); return r && EDIT[el.dataset.store](r); }
  if (a === 'scen') { await setMeta('activeScenario', id); return render(); }
  if (a === 'scen-add') return editScenario();
  if (a === 'bud-add') return editBudget(null, { scenario: scen().id, kind: el.dataset.kind });
  if (a === 'icat') { UI.itemCat = id; return render(); }
  if (a === 'plan') { UI.room = null; await setMeta('activePlan', id); return render(); }
  if (a === 'room') { const p = plan(), r = p?.rooms?.find(x => x.id === id); return r && editRoom(p, r); }
  if (a === 'cam') { UI.cam = id === 'top' ? { yaw: 0, pitch: Math.PI / 2, zoom: 1 } : { yaw: -0.55, pitch: 0.9, zoom: 1 }; return drawPlan(); }
  if (a === 'import') return pickFile();
  if (a === 'export') return exportBackup();
  if (a === 'share') return shareBackup();
  if (a === 'blank') { await put('scenarios', { name: '자금 현황', note: '' }); location.hash = '#/money'; return render(); }
  if (a === 'install' && installEvt) { installEvt.prompt(); installEvt = null; return; }
  if (a === 'persist') { const ok = navigator.storage?.persist ? await navigator.storage.persist() : false; toast(ok ? '저장공간 보호가 켜졌어요' : '보호를 켜지 못했어요 (홈 화면에 설치 후 다시 시도)'); return render(); }
  if (a === 'wipe') { if (await ask('모든 데이터를 삭제할까요?\n먼저 백업 파일을 내보내 두세요. 되돌릴 수 없어요.', '전체 삭제', 'danger')) { await clearAll(); toast('전체 삭제했어요'); render(); } }
});
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (route() === 'home') render(); });
window.addEventListener('appinstalled', () => { installEvt = null; navigator.storage?.persist?.(); render(); });

/* ---------- 시작 ---------- */
(async () => {
  db = await openDB(); await loadAll();
  if (!S.meta.firstUse) await setMeta('firstUse', Date.now());
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.X = { S, importData, clearAll, backupObj, loadAll, render, won, match, put, del, setMeta, APP_VERSION, UI, plan, rArea, drawPlan, HIT: () => HIT, NDIR: () => NDIR };
})();
