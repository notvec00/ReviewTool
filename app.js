'use strict';

const $ = (s) => document.querySelector(s);
const MIN_BOX = 4;       // image px
const HANDLE_R = 8;      // screen px

const S = {
  images: [],            // {name, el, w, h, boxes:[{label,x,y,w,h}], cls:{label,subs:[]}|null, origCls: same shape (as imported, reviewer only), annots: {annotatorName: cls}|{}, undo:[], redo:[]}
  cur: -1,
  labels: [],            // user-defined label names
  active: null,          // label used for new boxes
  sel: null,             // selected box (object in current image)
  task: 'boxes',         // 'boxes' | 'classify'
  cLabels: [],           // classification labels: {name, subs:[]}
  level: null,           // classification: label whose sublabels are shown (null = label list)
  role: 'annotator',     // 'annotator' | 'reviewer'
  panel: 'annotate',     // reviewer only: 'annotate' | 'feedback'
  mode: 'annotate',      // 'annotate' draws boxes, 'select' selects/moves/resizes
  view: { s: 1, x: 0, y: 0 },
  setupFiles: [],
  importJsons: [],       // {file, name, data}: annotation files picked on the import screen (several = one per annotator)
  annotators: [],        // names of the annotators being compared (reviewer, classification, 2+ files)
};

const cv = $('#cv');
const ctx = cv.getContext('2d');
let drag = null;
let spaceDown = false;
let hover = null;

/* ---------- helpers ---------- */

const natural = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const curImg = () => S.images[S.cur] || null;
const clsText = (c) => c.label + (c.subs.length ? ' › ' + c.subs.join(', ') : '');
const clsDone = (im) => {
  const l = im.cls && findCLabel(im.cls.label);
  return !!im.cls && (!l || !l.subs.length || im.cls.subs.length > 0);
};
const hasWork = (im) => im.boxes.length || im.feedback || im.cls;
const inFeedback = () => S.role === 'reviewer' && S.panel === 'feedback';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function show(id) {
  for (const s of ['start', 'setup', 'setupC', 'import', 'editor']) $('#' + s).classList.toggle('hidden', s !== id);
  if (id === 'editor') { resizeCanvas(); fit(); refresh(); }
}

let toastTimer;
function toast(msg, ms = 5000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function addLabel(raw) {
  const name = raw.trim();
  if (!name) return false;
  if (S.labels.some((l) => l.toLowerCase() === name.toLowerCase())) return false;
  S.labels.push(name);
  if (!S.active) S.active = name;
  return true;
}

function loadImages(files) {
  return Promise.all(files.map((f) => new Promise((resolve) => {
    const el = new Image();
    el.onload = () => resolve({ name: f.name, el, w: el.naturalWidth, h: el.naturalHeight, boxes: [], cls: null, origCls: null, annots: {}, feedback: '', undo: [], redo: [] });
    el.onerror = () => resolve(null);
    el.src = URL.createObjectURL(f);
  }))).then((list) => list.filter(Boolean));
}

async function addImages(files) {
  const known = new Set(S.images.map((i) => i.name));
  const fresh = files.filter((f) => !known.has(f.name));
  const loaded = await loadImages(fresh);
  const keep = curImg();
  S.images.push(...loaded);
  S.cur = keep ? S.images.indexOf(keep) : (S.images.length ? 0 : -1);
  return loaded.length;
}

/* ---------- start / setup ---------- */

function setRole(r) {
  S.role = r;
  $('#roleAnnotator').classList.toggle('active', r === 'annotator');
  $('#roleReviewer').classList.toggle('active', r === 'reviewer');
  $('#cardNew').classList.toggle('hidden', r === 'reviewer');   // reviewers can only import
  document.querySelectorAll('.reviewerOnly').forEach((el) => el.classList.toggle('hidden', r !== 'reviewer'));
}
$('#roleAnnotator').onclick = () => setRole('annotator');
$('#roleReviewer').onclick = () => setRole('reviewer');

const newMenu = $('#newMenu');
function toggleMenu(open) {
  newMenu.classList.toggle('hidden', !open);
  $('#btnNew').setAttribute('aria-expanded', String(open));
  if (open) newMenu.querySelector('button').focus();
}
$('#btnNew').onclick = (e) => { e.stopPropagation(); toggleMenu(newMenu.classList.contains('hidden')); };
document.addEventListener('click', () => toggleMenu(false));
newMenu.addEventListener('keydown', (e) => {
  const items = [...newMenu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  else if (e.key === 'Escape') { toggleMenu(false); $('#btnNew').focus(); }
});
$('#optBoxes').onclick = () => { S.task = 'boxes'; renderSetup(); show('setup'); };
$('#optClassify').onclick = () => { S.task = 'classify'; renderSetupC(); show('setupC'); };
$('#btnImport').onclick = () => { resetAll(); renderImport(); show('import'); };
$('#btnImportBack').onclick = () => show('start');
$('#btnPickJson').onclick = () => $('#fileJsonImport').click();
$('#btnPickImportImages').onclick = () => $('#fileImages').click();
$('#btnSetupBack').onclick = () => show('start');
$('#btnSetupBackC').onclick = () => show('start');
$('#btnPickImagesC').onclick = () => $('#fileImages').click();
$('#btnPickImages').onclick = () => $('#fileImages').click();

$('#setupLabelForm').onsubmit = (e) => {
  e.preventDefault();
  const inp = $('#setupLabelInput');
  addLabel(inp.value);
  inp.value = '';
  renderSetup();
};

let dragIdx = null;

function renderFileList(ul, rerender, sortable = true) {
  ul.innerHTML = '';
  S.setupFiles.forEach((f, i) => {
    const li = document.createElement('li');
    li.draggable = sortable;
    if (!sortable) li.style.cursor = 'default';
    li.innerHTML = (sortable ? '<span class="grip">⋮⋮</span>' : '<span class="grip"></span>') + '<span class="idx"></span><span class="fname"></span><button title="Remove">×</button>';
    li.children[1].textContent = i + 1;
    li.children[2].textContent = f.name;
    li.children[3].onclick = () => { S.setupFiles.splice(i, 1); rerender(); };
    li.ondragstart = (e) => { dragIdx = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); };
    li.ondragover = (e) => { e.preventDefault(); li.classList.add('over'); };
    li.ondragleave = () => li.classList.remove('over');
    li.ondragend = () => { dragIdx = null; };
    li.ondrop = (e) => {
      e.preventDefault();
      if (dragIdx === null || dragIdx === i) { li.classList.remove('over'); return; }
      const [m] = S.setupFiles.splice(dragIdx, 1);
      S.setupFiles.splice(i, 0, m);
      dragIdx = null;
      rerender();
    };
    ul.append(li);
  });
}

function resetAll() {
  S.images = []; S.cur = -1; S.labels = []; S.active = null; S.sel = null; S.cLabels = []; S.level = null;
  S.setupFiles = []; S.importJsons = []; S.annotators = []; S.panel = 'annotate';
}

$('#btnHome').onclick = () => {
  if (S.images.some(hasWork) &&
      !confirm('Go back to the start menu? Annotations that were not exported will be lost.')) return;
  resetAll();
  show('start');
};

function renderImport() {
  renderFileList($('#importImages'), renderImport, false);
  $('#importJsonInfo').classList.toggle('hidden', S.importJsons.length > 0);
  const ul = $('#importJsonList');
  ul.innerHTML = '';
  S.importJsons.forEach((j, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<input class="annotName" title="Annotator name (used in the CSV column names)" autocomplete="off"><span class="fname small"></span><button title="Remove">×</button>';
    const [inp, info, x] = li.children;
    inp.classList.toggle('hidden', S.importJsons.length < 2);
    inp.value = j.name;
    inp.onchange = () => { j.name = inp.value.trim() || j.name; inp.value = j.name; };
    info.textContent = `${j.file} · ${j.data.type === 'classification' ? 'classification' : 'bounding boxes'} · ${j.data.images.length} image(s)`;
    x.onclick = () => { S.importJsons.splice(i, 1); renderImport(); };
    ul.append(li);
  });
  $('#btnImportGo').disabled = !(S.importJsons.length && S.setupFiles.length);
}

function renderSetup() {
  renderFileList($('#setupImages'), renderSetup);
  const labs = $('#setupLabels');
  labs.innerHTML = '';
  S.labels.forEach((l, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><button title="Remove">×</button>';
    li.firstChild.textContent = l;
    li.lastChild.onclick = () => {
      S.labels.splice(i, 1);
      if (S.active === l) S.active = S.labels[0] || null;
      renderSetup();
    };
    labs.append(li);
  });
  $('#btnSetupGo').disabled = !(S.setupFiles.length && S.labels.length);
}

$('#fileImages').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  if ($('#editor').classList.contains('hidden')) {
    const known = new Set(S.setupFiles.map((f) => f.name));
    const fresh = files.filter((f) => !known.has(f.name)).sort(natural);
    S.setupFiles.push(...fresh);   // new batch sorted by name, then appended; reorder by dragging
    if (!$('#import').classList.contains('hidden')) renderImport();
    else if (!$('#setupC').classList.contains('hidden')) renderSetupC();
    else renderSetup();
  } else {
    await addImages(files);
    refresh(); draw();
  }
};

async function openEditorFromSetup() {
  S.images = [];
  S.cur = -1;
  S.level = null;
  await addImages(S.setupFiles);
  show('editor');
}
$('#btnSetupGo').onclick = openEditorFromSetup;
$('#btnSetupGoC').onclick = openEditorFromSetup;

/* ---------- import annotations ---------- */

function applyAnnotations(data) {
  if (!data || !Array.isArray(data.images)) throw new Error('Not a valid annotation file (missing "images").');
  const classify = data.type === 'classification';
  if (classify !== (S.task === 'classify')) {
    throw new Error(classify ? 'This is a classification file, but this session is for bounding boxes.' : 'This is a bounding-box file, but this session is for classification.');
  }
  if (classify) return applyClassification(data);
  (data.labels || []).forEach(addLabel);
  let boxes = 0, matched = 0;
  const missing = [];
  for (const entry of data.images) {
    const img = S.images.find((i) => i.name === entry.file_name);
    if (!img) { missing.push(entry.file_name); continue; }
    img.boxes = (entry.annotations || []).map((a) => {
      addLabel(a.label);
      return { label: a.label, x: +a.x, y: +a.y, w: +a.width, h: +a.height };
    });
    img.undo = []; img.redo = [];
    boxes += img.boxes.length; matched++;
  }
  return { boxes, matched, missing };
}

// Registers the file's labels and returns Map(file_name -> {label, subs} | null).
function collectClassification(data) {
  for (const l of data.labels || []) {
    addCLabel(l.name || l);
    for (const sub of l.sublabels || []) addCSub(l.name || l, sub);
  }
  const found = new Map();
  for (const entry of data.images) {
    let c = null;
    if (entry.label) {
      addCLabel(entry.label);
      const subs = entry.sublabels || (entry.sublabel ? [entry.sublabel] : []);
      subs.forEach((x) => addCSub(entry.label, x));
      c = { label: entry.label, subs: [...subs] };
    }
    found.set(entry.file_name, c);
  }
  return found;
}

function applyClassification(data) {
  let boxes = 0, matched = 0;
  const missing = [];
  for (const [file, c] of collectClassification(data)) {
    const img = S.images.find((i) => i.name === file);
    if (!img) { missing.push(file); continue; }
    img.cls = c;
    if (c) boxes++;
    matched++;
  }
  return { boxes, matched, missing, classify: true };
}

function importSummary(r) {
  let msg = r.classify ? `Restored ${r.boxes} classification(s) on ${r.matched} image(s).` : `Restored ${r.boxes} boxes on ${r.matched} image(s).`;
  if (r.missing.length) msg += ` Images not loaded: ${r.missing.join(', ')}.`;
  return msg;
}

// Several files (one per annotator) can be compared by a reviewer; everyone else loads a single file.
const uniqueAnnotator = (base) => {
  const taken = new Set([...S.importJsons.map((j) => j.name.toLowerCase()), 'reviewer']);
  let name = base, n = 2;
  while (taken.has(name.toLowerCase())) name = base + '_' + n++;
  return name;
};

$('#fileJsonImport').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const multi = S.role === 'reviewer';
  if (!multi) S.importJsons = [];
  for (const f of multi ? files : files.slice(0, 1)) {
    try {
      const data = JSON.parse(await f.text());
      if (!data || !Array.isArray(data.images)) throw new Error('Not a valid annotation file (missing "images").');
      const type = data.type === 'classification' ? 'classification' : 'boxes';
      const first = S.importJsons[0];
      if (first && (type !== 'classification' || first.data.type !== 'classification')) {
        throw new Error('Several annotation files can only be compared for classification.');
      }
      S.importJsons = S.importJsons.filter((j) => j.file !== f.name);
      S.importJsons.push({ file: f.name, name: uniqueAnnotator(f.name.replace(/\.json$/i, '')), data });
    } catch (err) { alert(`Could not read ${f.name}: ${err.message}`); }
  }
  renderImport();
};

$('#btnImportGo').onclick = async () => {
  try {
    S.images = []; S.cur = -1; S.labels = []; S.active = null; S.cLabels = []; S.level = null;
    S.annotators = [];
    const files = S.importJsons;
    S.task = files[0].data.type === 'classification' ? 'classify' : 'boxes';
    await addImages(S.setupFiles);
    // The JSON already carries the image order; images it doesn't list go last, in the order picked.
    const rank = new Map();
    for (const j of files) for (const e of j.data.images) if (!rank.has(e.file_name)) rank.set(e.file_name, rank.size);
    const pos = (im) => (rank.has(im.name) ? rank.get(im.name) : Infinity);
    S.images = S.images.map((im, i) => [im, i]).sort((a, b) => pos(a[0]) - pos(b[0]) || a[1] - b[1]).map((p) => p[0]);
    S.cur = S.images.length ? 0 : -1;
    if (files.length > 1) {
      // Compare mode: the reviewer starts empty and decides; every annotator's answer stays visible.
      S.annotators = files.map((j) => j.name);
      const missing = new Set();
      for (const j of files) {
        const found = collectClassification(j.data);
        for (const [file, c] of found) {
          const im = S.images.find((x) => x.name === file);
          if (im) im.annots[j.name] = c; else missing.add(file);
        }
      }
      show('editor');
      toast(`Loaded ${files.length} annotators: ${S.annotators.join(', ')}.` + (missing.size ? ` Images not loaded: ${[...missing].join(', ')}.` : ''));
      return;
    }
    const r = applyAnnotations(files[0].data);
    for (const im of S.images) im.origCls = im.cls && { label: im.cls.label, subs: [...im.cls.subs] };
    show('editor');
    toast(importSummary(r));
  } catch (err) { alert('Could not import: ' + err.message); }
};

$('#btnImportJson').onclick = () => $('#fileJson').click();
$('#btnCImportJson').onclick = () => $('#fileJson').click();
$('#fileJson').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const r = applyAnnotations(JSON.parse(await f.text()));
    S.sel = null; S.level = null; refresh(); draw();
    toast(importSummary(r));
  } catch (err) { alert('Could not import: ' + err.message); }
};

/* ---------- export ---------- */

// Lets the user pick the file name. Chrome/Edge open a native "Save as" dialog (name + folder);
// other browsers fall back to a name prompt and the normal downloads folder.
async function download(suggested, text, type) {
  const ext = suggested.slice(suggested.lastIndexOf('.'));
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: ext.slice(1).toUpperCase() + ' file', accept: { [type]: [ext] } }],
      });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      toast(`Saved ${handle.name}`);
    } catch (err) {
      if (err.name !== 'AbortError') alert('Could not save: ' + err.message);
    }
    return;
  }
  let name = prompt('File name:', suggested);
  if (name === null) return;
  name = name.trim() || suggested;
  if (!name.toLowerCase().endsWith(ext)) name += ext;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const r1 = (v) => Math.round(v * 10) / 10;

function exportJson() {
  if (S.task === 'classify') {
    const out = {
      format: 'ReviewTool/1',
      type: 'classification',
      labels: S.cLabels.map((l) => ({ name: l.name, sublabels: l.subs })),
      images: S.images.map((im) => ({
        file_name: im.name, width: im.w, height: im.h,
        label: im.cls ? im.cls.label : null, sublabels: im.cls ? im.cls.subs : [],
      })),
    };
    download('classification.json', JSON.stringify(out, null, 2), 'application/json');
    return;
  }
  const out = {
    format: 'ReviewTool/1',
    type: 'boxes',
    labels: S.labels,
    images: S.images.map((im) => ({
      file_name: im.name,
      width: im.w,
      height: im.h,
      annotations: im.boxes.map((b) => ({ label: b.label, x: r1(b.x), y: r1(b.y), width: r1(b.w), height: r1(b.h) })),
    })),
  };
  download('annotations.json', JSON.stringify(out, null, 2), 'application/json');
}
$('#btnExportJson').onclick = exportJson;
$('#btnCExportJson').onclick = exportJson;

const csvCell = (v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);

// Builds CSV text. Columns with no data in any row are left out (the "image" column always stays).
function toCsv(head, rows, keep = ['image']) {
  const cols = head.map((_, c) => c).filter((c) => keep.includes(head[c]) || rows.some((r) => String(r[c]) !== ''));
  return [head, ...rows].map((r) => cols.map((c) => csvCell(String(r[c]))).join(',')).join('\n') + '\n';
}

// Classification has a single sublabel level for now; several picks in a level are joined with ";".
const clsCells = (c) => [c ? c.label : '', c ? c.subs.join(';') : ''];
const clsHead = (prefix) => [prefix + 'label', prefix + 'sublabel_1'];

function exportCsv() {
  if (S.task === 'classify') {
    download('classification.csv', toCsv(['image', 'label', 'sublabel_1', 'feedback'],
      S.images.map((im) => [im.name, ...clsCells(im.cls), im.feedback])), 'text/csv');
    return;
  }
  const head = ['image', ...S.labels.map((l) => l + 's'), 'total'];
  const rows = S.images.map((im) => {
    const per = S.labels.map((l) => im.boxes.filter((b) => b.label === l).length);
    return [im.name, ...per, per.reduce((a, b) => a + b, 0)];
  });
  const sums = head.slice(1).map((_, c) => rows.reduce((a, r) => a + r[c + 1], 0));
  rows.push(['TOTAL', ...sums]);
  const csv = [head, ...rows].map((r) => r.map((c) => csvCell(String(c))).join(',')).join('\n') + '\n';
  download('counts.csv', csv, 'text/csv');
}
$('#btnExportCsv').onclick = exportCsv;
$('#btnCExportCsv').onclick = exportCsv;

function exportFeedback() {
  if (!S.images.some((im) => im.feedback)) { toast('There is no feedback to export yet.'); return; }
  download('feedback.csv', toCsv(['image', 'feedback'], S.images.map((im) => [im.name, im.feedback])), 'text/csv');
}

// Reviewer: what was imported next to what the reviewer ended up with.
function exportCompare() {
  download('classification_review.csv', toCsv(
    ['image', 'original_label', 'original_sublabel_1', 'reviewed_label', 'reviewed_sublabel_1', 'feedback'],
    S.images.map((im) => [im.name, ...clsCells(im.origCls), ...clsCells(im.cls), im.feedback])), 'text/csv');
}
$('#btnCExportCompare').onclick = exportCompare;

// Reviewer comparing several annotators: one label/sublabel column group per annotator, then the reviewer's.
function exportAnnotators() {
  const head = ['image', ...S.annotators.flatMap((n) => clsHead(n + '_')), ...clsHead('reviewer_'), 'feedback'];
  const rows = S.images.map((im) => [im.name, ...S.annotators.flatMap((n) => clsCells(im.annots[n])), ...clsCells(im.cls), im.feedback]);
  download('classification_annotators.csv', toCsv(head, rows), 'text/csv');
}
$('#btnCExportAnnotators').onclick = exportAnnotators;
$('#btnExportFeedback').onclick = exportFeedback;
$('#btnCExportFeedback').onclick = exportFeedback;

/* ---------- view ---------- */

function resizeCanvas() {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  draw();
}
window.addEventListener('resize', resizeCanvas);

function fit() {
  const im = curImg();
  const r = cv.getBoundingClientRect();
  if (!im || !r.width) return;
  const s = Math.min(r.width / im.w, r.height / im.h) * 0.96;
  S.view = { s, x: (r.width - im.w * s) / 2, y: (r.height - im.h * s) / 2 };
  draw();
}

const toImg = (px, py) => ({ x: (px - S.view.x) / S.view.s, y: (py - S.view.y) / S.view.s });
const toScr = (x, y) => ({ x: x * S.view.s + S.view.x, y: y * S.view.s + S.view.y });

function mousePos(e) {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/* ---------- drawing ---------- */

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const im = curImg();
  if (!im) return;
  const v = S.view;
  ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.x, dpr * v.y);
  ctx.imageSmoothingEnabled = v.s < 3;
  ctx.drawImage(im.el, 0, 0);

  const all = drag && drag.type === 'draw' && drag.moved ? [...im.boxes, drag.box] : im.boxes;
  const lw = 2 / v.s, fs = 13 / v.s;
  ctx.font = `${fs}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  const css = getComputedStyle(document.documentElement);
  const col = css.getPropertyValue('--box').trim(), colSel = css.getPropertyValue('--box-sel').trim();

  for (const b of all) {
    const sel = b === S.sel;
    ctx.strokeStyle = sel ? colSel : col;
    ctx.lineWidth = lw;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    const tw = ctx.measureText(b.label).width + 6 / v.s, th = fs + 4 / v.s;
    const ty = b.y - th >= 0 ? b.y - th : b.y;
    ctx.fillStyle = sel ? colSel : col;
    ctx.fillRect(b.x, ty, tw, th);
    ctx.fillStyle = '#000';
    ctx.fillText(b.label, b.x + 3 / v.s, ty + 2 / v.s);
  }
  if (S.sel && im.boxes.includes(S.sel)) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1 / v.s;
    const hs = 4 / v.s;
    for (const h of handlesOf(S.sel)) {
      ctx.fillRect(h.x - hs, h.y - hs, hs * 2, hs * 2);
      ctx.strokeRect(h.x - hs, h.y - hs, hs * 2, hs * 2);
    }
  }
}

function handlesOf(b) {
  const xm = b.x + b.w / 2, ym = b.y + b.h / 2, xr = b.x + b.w, yb = b.y + b.h;
  return [
    { n: 'nw', x: b.x, y: b.y }, { n: 'n', x: xm, y: b.y }, { n: 'ne', x: xr, y: b.y },
    { n: 'e', x: xr, y: ym }, { n: 'se', x: xr, y: yb }, { n: 's', x: xm, y: yb },
    { n: 'sw', x: b.x, y: yb }, { n: 'w', x: b.x, y: ym },
  ];
}

function hitHandle(b, p) {
  for (const h of handlesOf(b)) {
    const s = toScr(h.x, h.y);
    if (Math.hypot(s.x - p.x, s.y - p.y) <= HANDLE_R) return h.n;
  }
  return null;
}

const inside = (b, q) => q.x >= b.x && q.x <= b.x + b.w && q.y >= b.y && q.y <= b.y + b.h;

function hitBox(q) {
  const im = curImg();
  let best = null;
  for (const b of im.boxes) if (inside(b, q) && (!best || b.w * b.h < best.w * best.h)) best = b;
  return best;
}

/* ---------- history ---------- */

function pushUndo(im, snap) {
  im.undo.push(snap);
  if (im.undo.length > 100) im.undo.shift();
  im.redo = [];
}
const snapshot = (im) => JSON.stringify(im.boxes);

function undo() {
  const im = curImg();
  if (!im || !im.undo.length) return;
  im.redo.push(snapshot(im));
  im.boxes = JSON.parse(im.undo.pop());
  S.sel = null; refresh(); draw();
}
function redo() {
  const im = curImg();
  if (!im || !im.redo.length) return;
  im.undo.push(snapshot(im));
  im.boxes = JSON.parse(im.redo.pop());
  S.sel = null; refresh(); draw();
}

function deleteSelected() {
  const im = curImg();
  if (!im || !S.sel) return;
  pushUndo(im, snapshot(im));
  im.boxes = im.boxes.filter((b) => b !== S.sel);
  S.sel = null; refresh(); draw();
}

/* ---------- pointer interaction ---------- */

cv.addEventListener('pointerdown', (e) => {
  const im = curImg();
  if (!im) return;
  const p = mousePos(e);
  cv.setPointerCapture(e.pointerId);

  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    drag = { type: 'pan', sx: p.x, sy: p.y, vx: S.view.x, vy: S.view.y };
    return;
  }
  if (e.button !== 0 || inFeedback() || S.task === 'classify') return;

  const q = toImg(p.x, p.y);

  if (S.mode === 'select') {
    if (S.sel && im.boxes.includes(S.sel)) {
      const h = hitHandle(S.sel, p);
      if (h) {
        drag = { type: 'resize', h, box: S.sel, snap: snapshot(im), orig: { ...S.sel }, moved: false };
        return;
      }
    }
    const hit = (S.sel && inside(S.sel, q)) ? S.sel : hitBox(q);
    S.sel = hit;
    if (hit) {
      S.active = hit.label;
      drag = { type: 'move', box: hit, snap: snapshot(im), orig: { ...hit }, q0: q, moved: false };
    }
    refresh(); draw();
    return;
  }

  drag = {
    type: 'draw', sx: p.x, sy: p.y, q0: q, moved: false,
    snap: snapshot(im), box: { label: S.active, x: q.x, y: q.y, w: 0, h: 0 },
  };
});

cv.addEventListener('pointermove', (e) => {
  const im = curImg();
  if (!im) return;
  const p = mousePos(e);
  const q = toImg(p.x, p.y);
  hover = q;
  updateHud();

  if (!drag) {
    let cur = S.task === 'boxes' && S.mode === 'annotate' && !inFeedback() ? 'crosshair' : 'default';
    if (spaceDown) cur = 'grab';
    else if (S.mode === 'select' && !inFeedback()) {
      if (S.sel && im.boxes.includes(S.sel) && hitHandle(S.sel, p)) cur = hitHandle(S.sel, p) + '-resize';
      else if (hitBox(q)) cur = 'move';
    }
    cv.style.cursor = cur;
    return;
  }

  if (drag.type === 'pan') {
    S.view.x = drag.vx + (p.x - drag.sx);
    S.view.y = drag.vy + (p.y - drag.sy);
  } else if (drag.type === 'draw') {
    if (!drag.moved && Math.hypot(p.x - drag.sx, p.y - drag.sy) < 4) return;
    drag.moved = true;
    const x0 = clamp(drag.q0.x, 0, im.w), y0 = clamp(drag.q0.y, 0, im.h);
    const x1 = clamp(q.x, 0, im.w), y1 = clamp(q.y, 0, im.h);
    Object.assign(drag.box, { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
  } else if (drag.type === 'move') {
    drag.moved = true;
    const o = drag.orig;
    drag.box.x = clamp(o.x + q.x - drag.q0.x, 0, im.w - o.w);
    drag.box.y = clamp(o.y + q.y - drag.q0.y, 0, im.h - o.h);
  } else if (drag.type === 'resize') {
    drag.moved = true;
    const o = drag.orig;
    let l = o.x, t = o.y, r = o.x + o.w, b = o.y + o.h;
    const qx = clamp(q.x, 0, im.w), qy = clamp(q.y, 0, im.h);
    if (drag.h.includes('w')) l = qx;
    if (drag.h.includes('e')) r = qx;
    if (drag.h.includes('n')) t = qy;
    if (drag.h.includes('s')) b = qy;
    Object.assign(drag.box, { x: Math.min(l, r), y: Math.min(t, b), w: Math.abs(r - l), h: Math.abs(b - t) });
  }
  draw();
});

cv.addEventListener('pointerup', () => {
  const im = curImg();
  const d = drag;
  drag = null;
  if (!im || !d) return;

  if (d.type === 'draw') {
    if (d.moved && d.box.w >= MIN_BOX && d.box.h >= MIN_BOX) {
      if (!S.active) { toast('Add a label first (right panel).'); }
      else {
        pushUndo(im, d.snap);
        im.boxes.push(d.box);
      }
    }
  } else if (d.type === 'move' || d.type === 'resize') {
    if (d.moved) {
      if (d.box.w < MIN_BOX || d.box.h < MIN_BOX) Object.assign(d.box, d.orig);
      else pushUndo(im, d.snap);
    }
  }
  refresh(); draw();
});

cv.addEventListener('wheel', (e) => {
  if (!curImg()) return;
  e.preventDefault();
  const p = mousePos(e);
  const q = toImg(p.x, p.y);
  const s = clamp(S.view.s * Math.pow(1.0015, -e.deltaY), 0.05, 40);
  S.view = { s, x: p.x - q.x * s, y: p.y - q.y * s };
  updateHud(); draw();
}, { passive: false });

/* ---------- keyboard ---------- */

function typing(e) { return /^(TEXTAREA|SELECT)$/.test(e.target.tagName) || (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox'); }

window.addEventListener('keydown', (e) => {
  if (typing(e) || $('#editor').classList.contains('hidden')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (inFeedback() && !/^(Arrow(Left|Right)|Space)$/.test(e.code) && e.key.toLowerCase() !== 'f') return;
  if (e.code === 'Space') { spaceDown = true; e.preventDefault(); cv.style.cursor = 'grab'; return; }
  if (S.task === 'classify' && classifyKey(e, mod)) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
  if (e.key === 'ArrowLeft') { go(-1); return; }
  if (e.key === 'ArrowRight') { go(1); return; }
  if (e.key.toLowerCase() === 'f') { fit(); return; }
  if (e.key.toLowerCase() === 'a' && !mod && S.task === 'boxes') { setMode('annotate'); return; }
  if (e.key.toLowerCase() === 's' && !mod && S.task === 'boxes') { setMode('select'); return; }
  if (e.key === 'Escape') { S.sel = null; refresh(); draw(); return; }
  if (/^[1-9]$/.test(e.key) && !mod) setLabel(S.labels[+e.key - 1]);
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; cv.style.cursor = S.task === 'boxes' && S.mode === 'annotate' ? 'crosshair' : 'default'; } });

/* ---------- labels / navigation ---------- */

function setLabel(name) {
  if (!name) return;
  S.active = name;
  const im = curImg();
  if (im && S.sel && im.boxes.includes(S.sel) && S.sel.label !== name) {
    pushUndo(im, snapshot(im));
    S.sel.label = name;
  }
  refresh(); draw();
}

$('#labelForm').onsubmit = (e) => {
  e.preventDefault();
  const inp = $('#labelInput');
  addLabel(inp.value);
  inp.value = '';
  refresh();
};

function removeLabel(name) {
  const used = S.images.reduce((n, im) => n + im.boxes.filter((b) => b.label === name).length, 0);
  if (used && !confirm(`"${name}" is used by ${used} box(es). Remove the label and delete those boxes?`)) return;
  for (const im of S.images) { im.boxes = im.boxes.filter((b) => b.label !== name); im.undo = []; im.redo = []; }
  S.labels = S.labels.filter((l) => l !== name);
  if (S.active === name) S.active = S.labels[0] || null;
  S.sel = null; refresh(); draw();
}

$('#panelSelect').onchange = (e) => {
  S.panel = e.target.value;
  S.sel = null;
  e.target.blur();          // keep arrow keys for image navigation
  refresh(); draw();
};
$('#feedbackText').oninput = (e) => { const im = curImg(); if (im) im.feedback = e.target.value; };

function setMode(m) {
  S.mode = m;
  S.sel = null;
  cv.style.cursor = m === 'annotate' ? 'crosshair' : 'default';
  refresh(); draw();
}
$('#btnAnnotate').onclick = () => setMode('annotate');
$('#btnSelect').onclick = () => setMode('select');

function go(d) {
  const n = clamp(S.cur + d, 0, S.images.length - 1);
  if (n !== S.cur) setCur(n);
}
function setCur(i) { S.cur = i; S.sel = null; S.level = null; fit(); refresh(); }

$('#btnPrev').onclick = () => go(-1);
$('#btnNext').onclick = () => go(1);
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnDelete').onclick = deleteSelected;
$('#btnFit').onclick = fit;
$('#btnCFit').onclick = fit;
$('#btnCPrev').onclick = () => go(-1);
$('#btnCNext').onclick = () => go(1);
$('#btnCClear').onclick = clearCls;
$('#btnAddImages').onclick = () => $('#fileImages').click();

/* ---------- panels ---------- */

function updateHud() {
  const im = curImg();
  if (!im) { $('#hud').textContent = ''; return; }
  const cls = S.task === 'classify' && im.cls ? ` · ${clsText(im.cls)}` : '';
  const pos = hover ? ` · x ${Math.round(hover.x)}, y ${Math.round(hover.y)}` : '';
  $('#hud').textContent = `${im.name} (${S.cur + 1}/${S.images.length}) · ${im.w}×${im.h} · ${Math.round(S.view.s * 100)}%${cls}${pos}`;
}

function refresh() {
  const list = $('#imageList');
  list.innerHTML = '';
  S.images.forEach((im, i) => {
    const li = document.createElement('li');
    li.className = i === S.cur ? 'active' : '';
    li.innerHTML = '<span class="name"></span><span class="n"></span>';
    li.children[0].textContent = im.name;
    if (S.task === 'classify') {
      const done = clsDone(im);
      li.children[1].textContent = im.cls ? (done ? '✓' : '…') : '';
      li.children[1].className = 'n ' + (im.cls ? (done ? 'ok' : 'part') : '');
      li.title = im.cls ? clsText(im.cls) : 'Not classified';
    } else li.children[1].textContent = im.boxes.length;
    li.onclick = () => setCur(i);
    list.append(li);
  });

  const labs = $('#labelList');
  labs.innerHTML = '';
  S.labels.forEach((l, i) => {
    const li = document.createElement('li');
    li.className = l === S.active ? 'active' : '';
    li.innerHTML = '<span class="key"></span><span class="name"></span><button class="x" title="Remove label">×</button>';
    li.children[0].textContent = i < 9 ? i + 1 : '';
    li.children[1].textContent = l;
    li.onclick = () => setLabel(l);
    li.children[2].onclick = (ev) => { ev.stopPropagation(); removeLabel(l); };
    labs.append(li);
  });

  const im = curImg();
  const c = $('#counts');
  c.innerHTML = '';
  if (im) {
    for (const l of S.labels) {
      const d = document.createElement('div');
      d.innerHTML = '<span></span><b></b>';
      d.children[0].textContent = l;
      d.children[1].textContent = im.boxes.filter((b) => b.label === l).length;
      c.append(d);
    }
    const t = document.createElement('div');
    t.className = 'total';
    t.innerHTML = '<span>total</span><b></b>';
    t.children[1].textContent = im.boxes.length;
    c.append(t);
  }
  const reviewer = S.role === 'reviewer';
  if (!reviewer) S.panel = 'annotate';
  $('#roleBadge').textContent = S.role;
  $('#reviewerBar').classList.toggle('hidden', !reviewer);
  $('#panelSelect').value = S.panel;
  const classify = S.task === 'classify';
  $('#annotatePanel').classList.toggle('hidden', inFeedback() || classify);
  $('#classifyPanel').classList.toggle('hidden', inFeedback() || !classify);
  $('#btnCExportFeedback').classList.toggle('hidden', !reviewer);
  $('#btnCExportCompare').classList.toggle('hidden', !reviewer || S.annotators.length > 1);
  $('#btnCExportAnnotators').classList.toggle('hidden', !reviewer || S.annotators.length < 2);
  if (classify) renderClassify();
  $('#feedbackPanel').classList.toggle('hidden', !inFeedback());
  $('#btnExportFeedback').classList.toggle('hidden', !reviewer);
  const fb = $('#feedbackText');
  fb.disabled = !im;
  if (fb.value !== (im ? im.feedback : '')) fb.value = im ? im.feedback : '';
  $('#btnAnnotate').classList.toggle('active', S.mode === 'annotate');
  $('#btnSelect').classList.toggle('active', S.mode === 'select');
  $('#btnUndo').disabled = !(im && im.undo.length);
  $('#btnRedo').disabled = !(im && im.redo.length);
  $('#btnDelete').disabled = !(im && S.sel && im.boxes.includes(S.sel));
  $('#btnPrev').disabled = S.cur <= 0;
  $('#btnNext').disabled = S.cur >= S.images.length - 1;
  updateHud();
}

window.addEventListener('beforeunload', (e) => {
  if (S.images.some(hasWork)) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- classification ---------- */

const findCLabel = (name) => S.cLabels.find((l) => l.name === name);

function addCLabel(raw) {
  const name = String(raw).trim();
  if (!name || S.cLabels.some((l) => l.name.toLowerCase() === name.toLowerCase())) return false;
  S.cLabels.push({ name, subs: [] });
  return true;
}

function addCSub(label, raw) {
  const l = findCLabel(label), name = String(raw).trim();
  if (!l || !name || l.subs.some((x) => x.toLowerCase() === name.toLowerCase())) return false;
  l.subs.push(name);
  return true;
}

const autoAdvance = () => $('#cAuto').checked;

function finishClassify() {
  S.level = null;
  if (autoAdvance() && S.cur < S.images.length - 1) go(1);
  else refresh();
}

function pickLabel(name) {
  const im = curImg(), l = findCLabel(name);
  if (!im || !l) return;
  if (!im.cls || im.cls.label !== name) im.cls = { label: name, subs: [] };
  if (l.subs.length) { S.level = name; refresh(); }
  else finishClassify();
}

function pickSub(sub) {   // toggles: the last level allows several sublabels
  const im = curImg();
  if (!im || !S.level) return;
  if (!im.cls || im.cls.label !== S.level) im.cls = { label: S.level, subs: [] };
  const i = im.cls.subs.indexOf(sub);
  if (i >= 0) im.cls.subs.splice(i, 1); else im.cls.subs.push(sub);
  refresh();
}

function clearCls() {
  const im = curImg();
  if (!im) return;
  im.cls = null; S.level = null; refresh();
}

function classifyKey(e, mod) {
  if (mod) return false;
  if (/^[1-9]$/.test(e.key)) {
    const i = +e.key - 1;
    if (S.level) { const l = findCLabel(S.level); if (l && l.subs[i] !== undefined) pickSub(l.subs[i]); }
    else if (S.cLabels[i]) pickLabel(S.cLabels[i].name);
    return true;
  }
  if (e.key === 'Enter' && S.level) { e.preventDefault(); finishClassify(); return true; }
  if (e.key === 'Escape') { S.level = null; refresh(); return true; }
  if (e.key === 'Backspace') { e.preventDefault(); if (S.level) { S.level = null; refresh(); } else clearCls(); return true; }
  if (e.key === 'Delete') { e.preventDefault(); clearCls(); return true; }
  return /^[as]$/i.test(e.key);
}

function removeCLabel(name) {
  const used = S.images.filter((im) => im.cls && im.cls.label === name).length;
  if (used && !confirm(`"${name}" is used by ${used} image(s). Remove the label and clear those images?`)) return;
  for (const im of S.images) if (im.cls && im.cls.label === name) im.cls = null;
  S.cLabels = S.cLabels.filter((l) => l.name !== name);
  if (S.level === name) S.level = null;
  refresh();
}

function removeCSub(label, sub) {
  const hit = S.images.filter((im) => im.cls && im.cls.label === label && im.cls.subs.includes(sub));
  if (hit.length && !confirm(`"${sub}" is used by ${hit.length} image(s). Remove the sublabel and unset it on those images?`)) return;
  for (const im of hit) im.cls.subs = im.cls.subs.filter((x) => x !== sub);
  const l = findCLabel(label);
  l.subs = l.subs.filter((x) => x !== sub);
  refresh();
}

$('#cDone').onclick = finishClassify;
$('#cBack').onclick = () => { S.level = null; refresh(); };
$('#cForm').onsubmit = (e) => {
  e.preventDefault();
  const inp = $('#cInput');
  if (S.level) addCSub(S.level, inp.value); else addCLabel(inp.value);
  inp.value = '';
  refresh();
};
$('#cAuto').onchange = (e) => e.target.blur();

function renderClassify() {
  const im = curImg();
  let lvl = S.level ? findCLabel(S.level) : null;
  if (S.level && !lvl) S.level = null;
  $('#cCrumb').textContent = lvl ? `Sublabels of “${lvl.name}” (select several)` : 'Labels';
  $('#cBack').classList.toggle('hidden', !lvl);
  $('#cInput').placeholder = lvl ? `New sublabel in ${lvl.name}` : 'New label';

  const ul = $('#cList');
  ul.innerHTML = '';
  const items = lvl ? lvl.subs : S.cLabels.map((l) => l.name);
  items.forEach((name, i) => {
    const li = document.createElement('li');
    const active = im && im.cls && (lvl ? im.cls.label === lvl.name && im.cls.subs.includes(name) : im.cls.label === name);
    li.className = active ? 'active' : '';
    li.innerHTML = '<span class="key"></span><span class="name"></span><span class="sub"></span><button class="x" title="Remove">×</button>';
    li.children[0].textContent = i < 9 ? i + 1 : '';
    li.children[1].textContent = name;
    if (!lvl) {
      const n = findCLabel(name).subs.length;
      li.children[2].textContent = n ? `${n} sub ▸` : '';
    }
    li.onclick = () => (lvl ? pickSub(name) : pickLabel(name));
    li.children[3].onclick = (ev) => { ev.stopPropagation(); lvl ? removeCSub(lvl.name, name) : removeCLabel(name); };
    ul.append(li);
  });
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'small';
    li.style.cursor = 'default';
    li.textContent = lvl ? 'No sublabels yet. Add one below.' : 'No labels yet. Add one below.';
    ul.append(li);
  }

  const cur = $('#cCurrent');
  if (!im) cur.textContent = '';
  else if (!im.cls) cur.textContent = 'Not classified';
  else {
    cur.textContent = clsText(im.cls) + (clsDone(im) ? '' : ' › (choose a sublabel)');
  }
  const an = $('#cAnnots');
  an.innerHTML = '';
  an.classList.toggle('hidden', !im || S.annotators.length < 2);
  if (im && S.annotators.length > 1) {
    const same = S.annotators.every((n) => JSON.stringify(im.annots[n] || null) === JSON.stringify(im.annots[S.annotators[0]] || null));
    for (const n of S.annotators) {
      const d = document.createElement('div');
      d.innerHTML = '<span></span><b></b>';
      d.children[0].textContent = n;
      d.children[1].textContent = im.annots[n] ? clsText(im.annots[n]) : '—';
      an.append(d);
    }
    const t = document.createElement('div');
    t.className = 'small ' + (same ? 'agree' : 'differ');
    t.textContent = same ? 'Annotators agree' : 'Annotators differ';
    an.append(t);
  }
  const done = S.images.filter(clsDone).length;
  $('#cDone').classList.toggle('hidden', !lvl);
  $('#cProgress').textContent = `${done} / ${S.images.length} classified`;
  $('#btnCPrev').disabled = S.cur <= 0;
  $('#btnCNext').disabled = S.cur >= S.images.length - 1;
  $('#btnCClear').disabled = !(im && im.cls);
}

/* ---------- classification setup ---------- */

$('#setupLabelFormC').onsubmit = (e) => {
  e.preventDefault();
  const inp = $('#setupLabelInputC');
  addCLabel(inp.value);
  inp.value = '';
  renderSetupC();
  inp.focus();
};

function renderSetupC() {
  renderFileList($('#setupImagesC'), renderSetupC);
  const box = $('#setupLabelsC');
  box.innerHTML = '';
  S.cLabels.forEach((l, i) => {
    const d = document.createElement('div');
    d.className = 'lbl';
    d.innerHTML = '<div class="head"><span class="key"></span><span class="name"></span><button class="x" title="Remove label">×</button></div>' +
      '<div class="chips"></div><form><input placeholder="Add sublabel" autocomplete="off"><button>Add</button></form>';
    const head = d.children[0];
    head.children[0].textContent = i < 9 ? i + 1 : '';
    head.children[1].textContent = l.name;
    head.children[2].onclick = () => { S.cLabels.splice(i, 1); renderSetupC(); };
    l.subs.forEach((sub, j) => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.innerHTML = '<span></span><button class="x" title="Remove sublabel">×</button>';
      c.children[0].textContent = (j < 9 ? j + 1 + ' · ' : '') + sub;
      c.children[1].onclick = () => { l.subs.splice(j, 1); renderSetupC(); };
      d.children[1].append(c);
    });
    d.children[2].onsubmit = (e) => {
      e.preventDefault();
      addCSub(l.name, e.target.children[0].value);
      renderSetupC();
      $('#setupLabelsC').children[i].querySelector('input').focus();
    };
    box.append(d);
  });
  $('#btnSetupGoC').disabled = !(S.setupFiles.length && S.cLabels.length);
}
