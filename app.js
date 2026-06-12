'use strict';

// ─── Firebase ─────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyDRudb6bvkn3g5q9cQErbgql8HPkqLPmTA",
  authDomain:        "fit-track-76263.firebaseapp.com",
  projectId:         "fit-track-76263",
  storageBucket:     "fit-track-76263.firebasestorage.app",
  messagingSenderId: "619423355890",
  appId:             "1:619423355890:web:a8643e9b65d944e99d116b",
};

firebase.initializeApp(firebaseConfig);
const db  = firebase.firestore();
const COL = 'pac_monitoramento';

// ─── Configuração dos equipamentos ────────────────────────────────────────────
const EQUIP_CFG = {
  refrig: {
    label:   'Cont 1 - Refrigeração',
    refTemp: '0°C a 4°C',
    isOk:    t => t >= 0 && t <= 4,
    isWarn:  t => (t >= -1 && t < 0) || (t > 4 && t <= 5),
  },
  cong: {
    label:   'Cont 2 - Congelamento',
    refTemp: '−18°C',
    isOk:    t => t <= -18,
    isWarn:  t => t > -18 && t <= -15,
  },
};

const MONTHS_PT = [
  'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro',
];

// ─── Estado ───────────────────────────────────────────────────────────────────
let state = {
  equip:       'refrig',
  year:        new Date().getFullYear(),
  month:       new Date().getMonth(),
  editingDate: null,
};

let localCache    = { entries: {}, supervisor: { name: '', date: '' } };
let firestoreUnsub = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function monthKey() {
  return `${state.year}-${String(state.month + 1).padStart(2, '0')}`;
}
function docId()  { return `${state.equip}_${monthKey()}`; }
function docRef() { return db.collection(COL).doc(docId()); }

// ─── localStorage — backup local (funciona offline) ───────────────────────────
const LS_KEY = 'pac_backup_v2';

function lsAll() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch { return {}; }
}

function lsSaveCurrent() {
  try {
    const all = lsAll();
    all[docId()] = { entries: localCache.entries, supervisor: localCache.supervisor };
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch (_) {}
}

function lsLoadCurrent() {
  const data = lsAll()[docId()];
  return data
    ? { entries: data.entries || {}, supervisor: data.supervisor || { name:'', date:'' } }
    : { entries: {}, supervisor: { name:'', date:'' } };
}

// ─── Status de sincronização ──────────────────────────────────────────────────
function setSyncStatus(cls, label) {
  document.getElementById('syncStatus').className = `sync-status ${cls}`;
  document.getElementById('syncLabel').textContent = label;
}

// ─── Firestore: listener em tempo real ────────────────────────────────────────
function subscribeMonth() {
  if (firestoreUnsub) firestoreUnsub();

  // FIX 1: Renderizar imediatamente com dados do localStorage
  localCache = lsLoadCurrent();
  renderAll();
  setSyncStatus('syncing', 'Sincronizando...');

  firestoreUnsub = docRef().onSnapshot(
    snap => {
      if (snap.exists) {
        localCache = {
          entries:    snap.data().entries    || {},
          supervisor: snap.data().supervisor || { name:'', date:'' },
        };
        lsSaveCurrent(); // atualiza backup local
      }
      // Se não existe no Firestore, mantém o localStorage (já carregado acima)
      setSyncStatus('synced', 'Sincronizado');
      renderAll();
    },
    err => {
      console.warn('Firestore indisponível:', err.code || err.message);
      // FIX 3: Renderizar mesmo com erro — usa dados locais
      setSyncStatus('offline', 'Dados locais');
      renderAll();
    }
  );
}

// ─── Escrita no Firestore (sempre grava o cache completo) ─────────────────────
// FIX 2: Grava localCache.entries inteiro — nunca parcial — para não perder dados.
async function fsWrite() {
  setSyncStatus('syncing', 'Salvando...');
  try {
    await docRef().set({
      entries:    localCache.entries    || {},
      supervisor: localCache.supervisor || {},
    });
    setSyncStatus('synced', 'Sincronizado');
  } catch (err) {
    console.error('Erro Firebase:', err.code || err.message);
    setSyncStatus('offline', 'Salvo localmente');
    // Não lança exceção: dado já está no localStorage
  }
}

// ─── CRUD de entradas ─────────────────────────────────────────────────────────
function getEntries()    { return localCache.entries    || {}; }
function getSupervisor() { return localCache.supervisor || { name:'', date:'' }; }

async function saveEntry(dateStr, entry) {
  localCache.entries[dateStr] = entry;
  lsSaveCurrent();   // salva localmente primeiro
  renderTable();     // UI atualiza imediatamente
  await fsWrite();   // persiste no Firebase (async, sem bloquear UI)
}

async function deleteEntry(dateStr) {
  delete localCache.entries[dateStr];
  lsSaveCurrent();
  renderTable();
  await fsWrite();
}

async function saveSupervisorData(data) {
  localCache.supervisor = data;
  lsSaveCurrent();
  await fsWrite();
}

// ─── Renderização ─────────────────────────────────────────────────────────────
function renderAll() {
  const cfg = EQUIP_CFG[state.equip];

  document.getElementById('refTempLabel').textContent = cfg.refTemp;
  document.getElementById('equipLabel').textContent   = cfg.label;
  document.getElementById('monthLabel').textContent   =
    `${MONTHS_PT[state.month]} de ${state.year}`;

  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.equip === state.equip));

  renderTable();
  loadSupervisorPanel();
}

function tempClass(t, cfg) {
  if (cfg.isOk(t))   return 'temp-ok';
  if (cfg.isWarn(t)) return 'temp-warn';
  return 'temp-alarm';
}

function periodCells(e, period, cfg) {
  if (!e || !e[period]) return '<td></td><td></td>';
  const p = e[period];
  const isEmpty = p.temp === '' || p.temp === null || p.temp === undefined;
  if (isEmpty) return `<td>${p.hora || ''}</td><td></td>`;
  const t   = parseFloat(p.temp);
  const cls = tempClass(t, cfg);
  return `<td>${p.hora || ''}</td><td class="${cls}">${t.toFixed(1)}°C</td>`;
}

function renderTable() {
  const cfg     = EQUIP_CFG[state.equip];
  const entries = getEntries();
  const tbody   = document.getElementById('pacBody');
  const today   = new Date().toISOString().slice(0, 10);
  const days    = new Date(state.year, state.month + 1, 0).getDate();

  tbody.innerHTML = '';

  for (let d = 1; d <= days; d++) {
    const ds   = `${state.year}-${String(state.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dFmt = `${String(d).padStart(2, '0')}/${String(state.month + 1).padStart(2, '0')}/${state.year}`;
    const e    = entries[ds];
    const tr   = document.createElement('tr');

    if (ds === today) tr.classList.add('today-row');

    // Indicadores de turnos preenchidos
    function hasData(period) {
      return e && e[period] && e[period].temp !== '' && e[period].temp !== null && e[period].temp !== undefined;
    }
    const badges = e ? `
      <span class="turn-badge ${hasData('manha') ? 'filled' : 'empty'}" title="Manhã">M</span>
      <span class="turn-badge ${hasData('tarde')  ? 'filled' : 'empty'}" title="Tarde">T</span>
      <span class="turn-badge ${hasData('noite')  ? 'filled' : 'empty'}" title="Noite">N</span>
    ` : '';

    tr.innerHTML = `
      <td class="date-cell">
        ${dFmt}
        ${badges ? `<div class="turn-badges">${badges}</div>` : ''}
      </td>
      ${periodCells(e, 'manha', cfg)}
      ${periodCells(e, 'tarde', cfg)}
      ${periodCells(e, 'noite', cfg)}
      <td>${e ? (e.responsavel || '') : ''}</td>
      <td class="action-cell no-print">
        <button class="btn-icon" title="Editar / Adicionar turno" onclick="startEdit('${ds}')">✏</button>
        ${e ? `<button class="btn-icon btn-del" title="Excluir" onclick="delEntry('${ds}')">✕</button>` : ''}
      </td>`;

    tbody.appendChild(tr);
  }
}

// ─── Período automático baseado na hora atual ─────────────────────────────────
function currentPeriod() {
  const h = new Date().getHours();
  if (h >= 6  && h < 12) return 'manha';
  if (h >= 12 && h < 18) return 'tarde';
  return 'noite';
}

function currentTimeStr() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
}

// ─── Formulário ───────────────────────────────────────────────────────────────
function startEdit(dateStr, autoFill) {
  state.editingDate = dateStr;
  const e     = getEntries()[dateStr] || {};
  const parts = dateStr.split('-');
  const dFmt  = `${parts[2]}/${parts[1]}/${parts[0]}`;

  document.getElementById('formTitle').textContent = `Leitura de ${dFmt}`;
  document.getElementById('fDate').value           = dateStr;
  document.getElementById('fResp').value           = e.responsavel || '';

  const val = (obj, k) =>
    (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') ? obj[k] : '';

  document.getElementById('fManhaHora').value = val(e.manha, 'hora');
  document.getElementById('fManhaTemp').value = val(e.manha, 'temp');
  document.getElementById('fTardeHora').value = val(e.tarde, 'hora');
  document.getElementById('fTardeTemp').value = val(e.tarde, 'temp');
  document.getElementById('fNoiteHora').value = val(e.noite, 'hora');
  document.getElementById('fNoiteTemp').value = val(e.noite, 'temp');

  // Auto-preencher hora e período SOMENTE se a data for hoje
  const isToday = dateStr === new Date().toISOString().slice(0, 10);
  if (autoFill && isToday) {
    const periodo = currentPeriod();
    const hora    = currentTimeStr();
    const nomes   = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };
    const ids     = { manha: 'fManhaHora', tarde: 'fTardeHora', noite: 'fNoiteHora' };
    const tempIds = { manha: 'fManhaTemp', tarde: 'fTardeTemp', noite: 'fNoiteTemp' };

    if (!document.getElementById(ids[periodo]).value) {
      document.getElementById(ids[periodo]).value = hora;
    }

    document.getElementById('formTitle').textContent =
      `Leitura de ${dFmt} — ${nomes[periodo]}`;

    document.querySelectorAll('.period-block').forEach((blk, i) => {
      const periods = ['manha','tarde','noite'];
      blk.style.borderColor = periods[i] === periodo ? 'var(--blue)' : '';
      blk.style.background  = periods[i] === periodo ? '#eff6ff'     : '';
    });

    setTimeout(() => document.getElementById(tempIds[periodo]).focus(), 100);
  } else {
    // Lançamento antigo: sem auto-preenchimento, todos os campos livres
    document.querySelectorAll('.period-block').forEach(blk => {
      blk.style.borderColor = '';
      blk.style.background  = '';
    });
    if (!isToday) {
      setTimeout(() => document.getElementById('fManhaHora').focus(), 100);
    }
  }

  const form = document.getElementById('entryForm');
  form.style.display = 'block';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Abre formulário em branco para lançar um dia qualquer do mês exibido
function startEditBlank() {
  state.editingDate = null;

  const firstDay = `${state.year}-${String(state.month + 1).padStart(2,'0')}-01`;
  const lastDay  = new Date(state.year, state.month + 1, 0).getDate();
  const minDate  = firstDay;
  const maxDate  = `${state.year}-${String(state.month + 1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

  document.getElementById('formTitle').textContent = 'Lançamento Retroativo';
  document.getElementById('fDate').min   = minDate;
  document.getElementById('fDate').max   = maxDate;
  document.getElementById('fDate').value = '';
  document.getElementById('fResp').value = '';
  document.getElementById('fManhaHora').value = '';
  document.getElementById('fManhaTemp').value = '';
  document.getElementById('fTardeHora').value = '';
  document.getElementById('fTardeTemp').value = '';
  document.getElementById('fNoiteHora').value = '';
  document.getElementById('fNoiteTemp').value = '';

  document.querySelectorAll('.period-block').forEach(blk => {
    blk.style.borderColor = '';
    blk.style.background  = '';
  });

  const form = document.getElementById('entryForm');
  form.style.display = 'block';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => document.getElementById('fDate').focus(), 100);
}

function hideForm() {
  document.getElementById('entryForm').style.display = 'none';
  state.editingDate = null;

  // Limpa os limites de data que podem ter sido definidos por startEditBlank
  document.getElementById('fDate').min = '';
  document.getElementById('fDate').max = '';
}

async function saveEntryForm() {
  const dateStr = document.getElementById('fDate').value || state.editingDate;
  if (!dateStr) { alert('Selecione uma data.'); return; }

  const entry = {
    responsavel: document.getElementById('fResp').value.trim(),
    manha: {
      hora: document.getElementById('fManhaHora').value,
      temp: document.getElementById('fManhaTemp').value,
    },
    tarde: {
      hora: document.getElementById('fTardeHora').value,
      temp: document.getElementById('fTardeTemp').value,
    },
    noite: {
      hora: document.getElementById('fNoiteHora').value,
      temp: document.getElementById('fNoiteTemp').value,
    },
  };

  // Alerta de temperatura fora do limite
  const cfg      = EQUIP_CFG[state.equip];
  const nomes    = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };
  const fora     = ['manha','tarde','noite'].filter(p => {
    const t = parseFloat(entry[p].temp);
    return entry[p].temp !== '' && !isNaN(t) && !cfg.isOk(t) && !cfg.isWarn(t);
  });

  if (fora.length > 0) {
    const ok = confirm(
      `⚠ TEMPERATURA FORA DO LIMITE!\n\nPeríodo(s): ${fora.map(p => nomes[p]).join(', ')}\nReferência: ${cfg.refTemp}\n\nDeseja salvar mesmo assim?`
    );
    if (!ok) return;
  }

  const btn = document.getElementById('btnSave');
  btn.disabled = true;
  btn.textContent = 'Salvando...';
  try {
    await saveEntry(dateStr, entry);
    hideForm();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar Leitura';
  }
}

async function delEntry(dateStr) {
  const p = dateStr.split('-');
  if (!confirm(`Excluir leitura de ${p[2]}/${p[1]}/${p[0]}?`)) return;
  await deleteEntry(dateStr);
}

// ─── Supervisor ───────────────────────────────────────────────────────────────
function loadSupervisorPanel() {
  const sup = getSupervisor();
  document.getElementById('supervisorName').value = sup.name || '';
  document.getElementById('supervisorDate').value = sup.date || '';
}

let supTimer = null;
['supervisorName', 'supervisorDate'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    clearTimeout(supTimer);
    supTimer = setTimeout(() => {
      saveSupervisorData({
        name: document.getElementById('supervisorName').value,
        date: document.getElementById('supervisorDate').value,
      });
    }, 800);
  });
});

// ─── Impressão ────────────────────────────────────────────────────────────────
function printPAC() {
  const cfg     = EQUIP_CFG[state.equip];
  const entries = getEntries();
  const sup     = getSupervisor();
  const days    = new Date(state.year, state.month + 1, 0).getDate();

  function printPeriod(e, period) {
    if (!e || !e[period]) return '<td></td><td></td>';
    const p       = e[period];
    const hasTemp = p.temp !== '' && p.temp !== null && p.temp !== undefined;
    if (!hasTemp) return `<td>${p.hora || ''}</td><td></td>`;
    const t     = parseFloat(p.temp);
    const alarm = !cfg.isOk(t) && !cfg.isWarn(t);
    return `<td>${p.hora || ''}</td><td${alarm ? ' class="print-alarm"' : ''}>${t.toFixed(1)}°C</td>`;
  }

  let rows = '';
  for (let d = 1; d <= days; d++) {
    const ds   = `${state.year}-${String(state.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dFmt = `${String(d).padStart(2, '0')}/${String(state.month + 1).padStart(2, '0')}/${state.year}`;
    const e    = entries[ds];
    rows += `<tr>
      <td>${dFmt}</td>
      ${printPeriod(e, 'manha')}
      ${printPeriod(e, 'tarde')}
      ${printPeriod(e, 'noite')}
      <td>${e ? (e.responsavel || '') : ''}</td>
    </tr>`;
  }

  const supDate = sup.date ? sup.date.split('-').reverse().join('/') : '';

  document.getElementById('printView').innerHTML = `
<div class="pac-doc">
  <table class="pac-header-table">
    <tr>
      <td class="logo-cell" style="width:130px">
        <div class="print-logo">
          <span class="logo-big">REI</span><br>
          <span class="logo-sub">da Mussarela<br>e do Pão de Queijo</span>
        </div>
      </td>
      <td class="title-cell">PAC - Planilha de monitoramento de temperatura.</td>
      <td class="meta-cell">
        <div>Data de emissão: 01/04/26</div>
        <div>Revisão nº: &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Data:</div>
        <div>Documento: 01</div>
      </td>
    </tr>
  </table>
  <table class="pac-info-table">
    <tr><td><strong>Responsável:</strong> Setor de produção</td></tr>
    <tr><td><strong>Frequência:</strong> 3 X ao dia</td></tr>
    <tr><td><strong>Objetivo:</strong> Monitorar temperatura da rede de frio</td></tr>
    <tr><td><strong>Temperatura de referência:</strong> ${cfg.refTemp}</td></tr>
    <tr><td><strong><u>Equipamento: ${cfg.label}</u></strong></td></tr>
  </table>
  <table class="pac-data-table">
    <thead>
      <tr>
        <th rowspan="2" style="width:80px">Data: d/m/a</th>
        <th colspan="2">Manhã</th>
        <th colspan="2">Tarde</th>
        <th colspan="2">Noite</th>
        <th rowspan="2">Responsável</th>
      </tr>
      <tr>
        <th>Horário</th><th>Temperatura</th>
        <th>Horário</th><th>Temperatura</th>
        <th>Horário</th><th>Temperatura</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="pac-footer">
    <div>Nome do supervisor: ${sup.name || ''}</div>
    <div>Assinatura:</div>
    <div>Data: ${supDate}</div>
  </div>
</div>`;

  window.print();
}

// ─── Exportar CSV ─────────────────────────────────────────────────────────────
function exportCSV() {
  const cfg     = EQUIP_CFG[state.equip];
  const entries = getEntries();
  const days    = new Date(state.year, state.month + 1, 0).getDate();
  const sup     = getSupervisor();

  const rows = [
    ['PAC - Planilha de Monitoramento de Temperatura'],
    [`Equipamento: ${cfg.label}`, `Temp. Referência: ${cfg.refTemp}`],
    [`Mês: ${MONTHS_PT[state.month]} ${state.year}`],
    [`Supervisor: ${sup.name}`],
    [],
    ['Data','Manhã - Horário','Manhã - Temperatura (°C)',
     'Tarde - Horário','Tarde - Temperatura (°C)',
     'Noite - Horário','Noite - Temperatura (°C)','Responsável'],
  ];

  for (let d = 1; d <= days; d++) {
    const ds   = `${state.year}-${String(state.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dFmt = `${String(d).padStart(2, '0')}/${String(state.month + 1).padStart(2, '0')}/${state.year}`;
    const e    = entries[ds] || {};
    rows.push([
      dFmt,
      (e.manha && e.manha.hora)  || '',
      (e.manha && e.manha.temp !== '' && e.manha.temp !== undefined) ? e.manha.temp : '',
      (e.tarde && e.tarde.hora)  || '',
      (e.tarde && e.tarde.temp !== '' && e.tarde.temp !== undefined) ? e.tarde.temp : '',
      (e.noite && e.noite.hora)  || '',
      (e.noite && e.noite.temp !== '' && e.noite.temp !== undefined) ? e.noite.temp : '',
      e.responsavel || '',
    ]);
  }

  const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download:
    `PAC_${state.equip}_${state.year}-${String(state.month + 1).padStart(2, '0')}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

// ─── Eventos ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    state.equip = tab.dataset.equip;
    hideForm();
    subscribeMonth();
  });
});

document.getElementById('prevMonth').addEventListener('click', () => {
  if (--state.month < 0) { state.month = 11; state.year--; }
  hideForm();
  subscribeMonth();
});

document.getElementById('nextMonth').addEventListener('click', () => {
  if (++state.month > 11) { state.month = 0; state.year++; }
  hideForm();
  subscribeMonth();
});

document.getElementById('btnAdd').addEventListener('click', () => {
  const today = new Date().toISOString().slice(0, 10);
  const [y, m] = today.split('-').map(Number);
  const noMesAtual = y === state.year && m - 1 === state.month;

  if (noMesAtual) {
    // Mês atual: abre no dia de hoje com auto-preenchimento de hora/período
    startEdit(today, true);
  } else {
    // Mês passado: abre o formulário com data em branco para o usuário escolher o dia
    startEditBlank();
  }
});

document.getElementById('btnSave').addEventListener('click', saveEntryForm);
document.getElementById('btnCancel').addEventListener('click', hideForm);
document.getElementById('btnCancelBottom').addEventListener('click', hideForm);
document.getElementById('btnPrint').addEventListener('click', printPAC);
document.getElementById('btnExport').addEventListener('click', exportCSV);

// ─── Inicialização ────────────────────────────────────────────────────────────
// subscribeMonth já faz: carrega localStorage → renderiza → conecta Firestore
subscribeMonth();
