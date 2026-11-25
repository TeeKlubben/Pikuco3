/* ============================================================
   МЕТАРЕДАКТОР — изолированный модуль
   Не трогает существующий код. Подключается одним <script>.
   ============================================================ */
(function(){
'use strict';

// ---------- короткие ссылки ----------
const $ = id => document.getElementById(id);
const sb = window.sb;
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- константы ----------
const BUCKET = 'meta-images';
const GRID = 20;              // шаг сетки блока, условных px
const BLOCK_W = 800;          // условная ширина блока
const BLOCK_H = 600;          // условная высота блока
const SCHEMA_VERSION = 1;

// реестр типов элементов. Расширяется: META.registerElement({...})
const ELEMENT_TYPES = {
  // ----- OUTPUT -----
  text: {
    category: 'output', name: 'Текст', icon: 'Т',
    defaultSize: { w: 320, h: 40 },
    props: { text: '' },
    render: (el, ctx) => `<div class="meta-text">${esc(el.props.text || '')}</div>`
  },
  desc: {
    category: 'output', name: 'Описание', icon: 'О',
    defaultSize: { w: 360, h: 60 },
    props: { text: '' },
    render: (el, ctx) => `<div class="meta-desc">${esc(el.props.text || '')}</div>`
  },
  image: {
    category: 'output', name: 'Иллюстрация', icon: '🖼',
    defaultSize: { w: 260, h: 180 },
    props: { url: '' },
    render: (el, ctx) => el.props.url
      ? `<img class="meta-img" src="${esc(el.props.url)}" alt="">`
      : `<div class="meta-img-ph">нет картинки</div>`
  },
  // ----- INPUT -----
  input_text: {
    category: 'input', name: 'Поле ввода', icon: '⌨',
    defaultSize: { w: 320, h: 48 },
    props: { placeholder: 'Введите ответ…' },
    render: (el, ctx) => `<input class="meta-input" placeholder="${esc(el.props.placeholder || '')}" ${ctx.play ? '' : 'disabled'}>`
  },
  // ----- LOGIC -----
  compare: {
    category: 'logic', name: 'Сравнение ответа', icon: '≡',
    defaultSize: { w: 300, h: 140 },
    props: { variants: [{ text: '', points: 0 }] },
    render: (el, ctx) => {
      const v = (el.props.variants || []).map(x => `<div class="meta-cmp-row"><span>${esc(x.text || '…')}</span><b>+${Number(x.points)||0}</b></div>`).join('');
      return `<div class="meta-compare">${v || '<span class="meta-muted">пусто</span>'}</div>`;
    }
  }
};

// ---------- состояние модуля ----------
const M = {
  project: null,        // текущий проект: { id, title, description, avatar, data, published }
  page: null,           // контейнер страницы
  mode: 'edit',         // 'edit' | 'design' | 'play'
  fullscreen: false,
  selectedBlockId: null,
  selectedElId: null,
  drag: null,           // { kind:'element'|'block', type, ... }
  dirty: false,
  error: ''
};

// ---------- утилиты проекта ----------
function newProject(){
  return {
    id: null,
    title: '',
    description: '',
    avatar: '',
    published: false,
    data: {
      schemaVersion: SCHEMA_VERSION,
      startBlockId: null,
      blocks: [],       // { id, x, y, title, bg, elements:[] }
      links: []         // { id, from, to, condition:{ op:'=', value:0 } | null }
    }
  };
}

function findBlock(id){ return M.project.data.blocks.find(b => b.id === id) || null; }
function findElement(blockId, elId){
  const b = findBlock(blockId);
  return b ? (b.elements.find(e => e.id === elId) || null) : null;
}
function allElements(){
  const out = [];
  M.project.data.blocks.forEach(b => b.elements.forEach(e => out.push({ block: b, el: e })));
  return out;
}
function findCompareForInput(inputId){
  // какой compare подключён к этому инпуту? (связь input -> compare)
  const link = M.project.data.links.find(l => l.kind === 'data' && l.from === inputId && l.to && l.to.startsWith('cmp:'));
  if(!link) return null;
  const [, blockId, cmpId] = link.to.split(':');
  return findElement(blockId, cmpId);
}
function isInputConnected(inputId){
  return !!findCompareForInput(inputId);
}

// ---------- сетка / коллизии ----------
const snap = v => Math.round(v / GRID) * GRID;
function rectsOverlap(a, b){
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}
function fitsInBlock(el){
  return el.x >= 0 && el.y >= 0 && el.x + el.w <= BLOCK_W && el.y + el.h <= BLOCK_H;
}
function collides(block, el){
  return block.elements.some(other => other.id !== el.id && rectsOverlap(el, other));
}

// ---------- Supabase: загрузка картинки ----------
async function uploadMetaImage(file){
  if(!file) return '';
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const name = Date.now() + '-' + uid() + '.' + ext;
  const { error } = await sb.storage.from(BUCKET).upload(name, file);
  if(error) throw error;
  return sb.storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
}

// ---------- Supabase: проекты ----------
async function loadProject(id){
  const { data, error } = await sb.from('meta_projects').select('*').eq('id', id).maybeSingle();
  if(error) throw error;
  if(!data) return null;
  return {
    id: data.id,
    title: data.title || '',
    description: data.description || '',
    avatar: data.avatar || '',
    published: !!data.published,
    data: Object.assign(newProject().data, data.data || {})
  };
}

async function listMyProjects(){
  const { data, error } = await sb.from('meta_projects')
    .select('id, title, description, avatar, published, updated_at')
    .eq('author_id', window.currentUser.id)
    .order('updated_at', { ascending: false });
  if(error) throw error;
  return data || [];
}

async function listPublishedProjects(){
  const { data, error } = await sb.from('meta_projects')
    .select('id, title, description, avatar, author_id, created_at, profiles(login)')
    .eq('published', true)
    .order('created_at', { ascending: false });
  if(error) throw error;
  return data || [];
}

async function saveProject(publish){
  const { data: sess } = await sb.auth.getSession();
  const user = sess && sess.session ? sess.session.user : null;
  if(!user) throw new Error('Нужно войти в аккаунт');
  const row = {
    title: M.project.title || 'Без названия',
    description: M.project.description || '',
    avatar: M.project.avatar || '',
    data: M.project.data,
    published: !!publish,
    updated_at: new Date().toISOString()
  };
  if(M.project.id){
    const { error } = await sb.from('meta_projects').update(row).eq('id', M.project.id);
    if(error) throw error;
  } else {
    row.author_id = user.id;
    const { data, error } = await sb.from('meta_projects').insert(row).select().single();
    if(error) throw error;
    M.project.id = data.id;
  }
  M.project.published = !!publish;
  M.dirty = false;
  return M.project.id;
}

// ---------- Экспорт/импорт ----------
function exportJSON(){
  const payload = {
    meta: { title: M.project.title, description: M.project.description, avatar: M.project.avatar },
    data: M.project.data
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (M.project.title || 'meta-project') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
function importJSON(file){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const obj = JSON.parse(r.result);
        if(!obj || !obj.data) throw new Error('Неверный файл');
        M.project.title = (obj.meta && obj.meta.title) || M.project.title;
        M.project.description = (obj.meta && obj.meta.description) || '';
        M.project.avatar = (obj.meta && obj.meta.avatar) || '';
        M.project.data = Object.assign(newProject().data, obj.data);
        M.dirty = true;
        resolve();
      } catch(e){ reject(e); }
    };
    r.onerror = () => reject(new Error('Не удалось прочитать файл'));
    r.readAsText(file);
  });
}

// экспорт наружу (для route и main page)
window.META = window.META || {};
window.META.registerElement = function(type, def){
  if(!def || !def.category) throw new Error('registerElement: нужен category');
  ELEMENT_TYPES[type] = def;
};
window.META._M = M;
window.META._types = ELEMENT_TYPES;
window.META._util = { esc, uid, snap, rectsOverlap, fitsInBlock, collides, findBlock, findElement, allElements,
  findCompareForInput, isInputConnected, newProject, loadProject, listMyProjects, listPublishedProjects,
  saveProject, exportJSON, importJSON, uploadMetaImage, BLOCK_W, BLOCK_H, GRID };


// ============================================================
//   ЧАСТЬ 2: СТРАНИЦА РЕДАКТОРА
// ============================================================

// ---------- инжект стилей ----------
function injectStyles(){
  if($('meta-styles')) return;
  const st = document.createElement('style');
  st.id = 'meta-styles';
  st.textContent = `
  #metaPage{padding:24px;max-width:1400px;margin:0 auto}
  .meta-top{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
  .meta-top .btn{white-space:nowrap}
  .meta-head{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;background:var(--white);color:var(--text);border-radius:16px;padding:20px;margin-bottom:16px}
  .meta-head-fields{flex:1;min-width:260px}
  .meta-head-preview{width:220px;flex-shrink:0}
  .meta-card{background:var(--white);border:2px solid var(--card-border);border-radius:16px;padding:16px;display:flex;flex-direction:column;align-items:center;text-align:center}
  .meta-card .test-icon{width:100%;height:110px;border-radius:12px;background:var(--yellow);display:flex;align-items:center;justify-content:center;font-size:46px;margin-bottom:10px;overflow:hidden}
  .meta-card .test-icon img{width:100%;height:100%;object-fit:cover}
  .meta-card h3{font-size:16px;color:var(--red);margin-bottom:6px;word-break:break-word}
  .meta-card .desc{font-size:13px;color:var(--muted);word-break:break-word}
  .meta-msg{font-size:14px;margin-top:8px;min-height:18px;color:#fff}
  .meta-msg.err{color:#ffd0d0}
  .meta-msg.ok{color:#c9ffd8}

  /* полотно */
  .meta-canvas-wrap{position:relative;background:#e8e8e8;border-radius:16px;overflow:hidden;height:640px;border:2px solid #ccc}
  .meta-canvas-wrap.fs{position:fixed;inset:0;z-index:2000;border-radius:0;height:100vh}
  .meta-canvas{position:absolute;inset:0;overflow:auto;background:#f7f7f7;
    background-image:linear-gradient(#e0e0e0 1px,transparent 1px),linear-gradient(90deg,#e0e0e0 1px,transparent 1px);
    background-size:20px 20px}
  .meta-canvas-inner{position:relative;width:2000px;height:1600px}

  /* блок на полотне */
  .meta-block{position:absolute;background:#fff;border:3px solid #c0c0c0;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.08);cursor:pointer;overflow:hidden}
  .meta-block.start{border-color:#2ea043}
  .meta-block.end{border-color:var(--red)}
  .meta-block.sel{border-color:var(--yellow);box-shadow:0 0 0 4px rgba(244,226,56,.4)}
  .meta-block .mb-title{position:absolute;top:0;left:0;right:0;padding:4px 8px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;font-weight:700;display:flex;justify-content:space-between;align-items:center;z-index:2;pointer-events:none}
  .meta-block .mb-body{position:absolute;inset:28px 0 0 0;background:#fbfbfb;overflow:hidden}
  .meta-block .mb-body-img{position:absolute;inset:0;background-size:cover;background-position:center;opacity:.35}

  /* элементы внутри блока (в редакторе) */
  .meta-el{position:absolute;border:2px dashed #9bbad6;background:rgba(255,255,255,.85);border-radius:6px;padding:4px;font-size:13px;color:#222;cursor:move;user-select:none;overflow:hidden}
  .meta-el.sel{border-color:var(--red);box-shadow:0 0 0 2px rgba(208,22,44,.25)}
  .meta-el.bad{border-color:var(--red);background:#fff0f0}
  .meta-el .me-id{position:absolute;top:2px;right:4px;font-size:10px;font-weight:700;background:#333;color:#fff;border-radius:4px;padding:0 4px;cursor:pointer;z-index:3}
  .meta-el .me-id.ok{background:#2ea043}
  .meta-el .me-body{margin-top:14px;pointer-events:none;word-break:break-word}
  .meta-el .me-dot{position:absolute;right:-9px;top:50%;transform:translateY(-50%);width:14px;height:14px;border-radius:50%;background:var(--red);border:2px solid #fff;cursor:crosshair;z-index:4}
  .meta-el .me-body input{width:100%}
  .meta-text{font-size:16px;font-weight:700}
  .meta-desc{font-size:13px;color:#555}
  .meta-img{width:100%;height:100%;object-fit:cover;border-radius:4px}
  .meta-img-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#ddd;color:#777;font-size:12px;border-radius:4px}
  .meta-input{width:100%;padding:6px 8px;border:2px solid #ccc;border-radius:6px;font-family:inherit;font-size:14px;background:#fff}
  .meta-compare{font-size:11px}
  .meta-cmp-row{display:flex;justify-content:space-between;gap:6px;padding:2px 0;border-bottom:1px solid #eee}
  .meta-muted{color:#999}

  /* стрелки (svg overlay) */
  .meta-lines{position:absolute;inset:0;pointer-events:none;z-index:1}
  .meta-lines svg{width:100%;height:100%}
  .meta-link-line{stroke:#888;stroke-width:2;fill:none}
  .meta-link-line.data{stroke:var(--red);stroke-dasharray:5 4}
  .meta-link-hit{stroke:transparent;stroke-width:14;fill:none;pointer-events:stroke;cursor:pointer}
  .meta-link-hit:hover + .meta-link-line{stroke:var(--yellow);stroke-width:3}

  /* нижний тулбар */
  .meta-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--white);color:var(--text);border-radius:14px;padding:10px 14px;margin-top:12px}
  .meta-tb-group{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:4px 8px;border-radius:10px;background:#f4f4f4}
  .meta-tb-group b{font-size:12px;color:var(--muted);margin-right:4px}
  .meta-tb-item{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 10px;border-radius:8px;background:#fff;border:2px solid #e2e2e2;cursor:grab;font-size:12px;font-weight:700;color:var(--text);user-select:none;min-width:64px}
  .meta-tb-item:hover{border-color:var(--yellow)}
  .meta-tb-item .ico{font-size:18px}
  .meta-tb-item[data-cat="logic"]{background:#fff4f4;border-color:#f3c8c8}
  .meta-tb-item[data-cat="input"]{background:#eef6ff;border-color:#c8ddf3}

  /* меню справа (при клике на инпут-элемент в тулбаре) */
  .meta-pop{position:fixed;background:var(--white);color:var(--text);border:2px solid var(--yellow);border-radius:12px;padding:10px;z-index:3000;display:none;box-shadow:0 6px 24px rgba(0,0,0,.25);min-width:220px}
  .meta-pop.open{display:block}
  .meta-pop h4{font-size:13px;color:var(--red);margin-bottom:8px}

  /* правая панель свойств */
  .meta-right{width:300px;flex-shrink:0;position:sticky;top:80px;align-self:flex-start;background:var(--white);color:var(--text);border-radius:16px;padding:16px}
  .meta-right h3{font-size:15px;color:var(--red);margin-bottom:10px}
  .meta-right .field{margin-bottom:10px}
  .meta-right .field label{display:block;font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px}
  .meta-right .field input,.meta-right .field textarea,.meta-right .field select{width:100%;padding:8px 10px;border:2px solid #e2e2e2;border-radius:8px;font-family:inherit;font-size:14px;background:#fff;color:var(--text)}
  .meta-right .meta-cmp-edit{display:flex;gap:6px;align-items:center;margin-bottom:6px}
  .meta-right .meta-cmp-edit input[type=text]{flex:1;min-width:0}
  .meta-right .meta-cmp-edit input[type=number]{width:70px}
  .meta-right .meta-danger{background:#fff;color:var(--red);border:2px solid var(--red);border-radius:8px;padding:6px 10px;cursor:pointer;font-weight:700}
  .meta-right .meta-danger:hover{background:var(--red);color:#fff}
  .meta-right .meta-hint{font-size:11px;color:var(--muted);margin-top:4px}
  .meta-empty{color:var(--muted);font-size:13px;font-style:italic}

  .meta-editor-layout{display:flex;gap:16px;align-items:flex-start}
  .meta-editor-main{flex:1;min-width:0}

  /* ошибки */
  .meta-errors{background:#fff4f4;border:2px solid #f3c8c8;border-radius:12px;padding:12px;margin-top:12px;color:#a81223;font-size:13px}
  .meta-errors ul{margin:6px 0 0 18px}
  .meta-errors li{margin-bottom:4px}

  /* режим play */
  .meta-play{background:#111;border-radius:16px;overflow:hidden;padding:0;position:relative;height:640px}
  .meta-play-inner{position:absolute;inset:0;background-size:cover;background-position:center;display:flex;align-items:stretch;justify-content:stretch}
  .meta-play .meta-el{border:none;background:transparent;cursor:default}
  .meta-play .meta-el .me-id,.meta-play .meta-el .me-dot{display:none}
  .meta-play .meta-el .me-body{margin-top:0;pointer-events:auto}
  .meta-play-result{position:absolute;inset:0;background:rgba(0,0,0,.75);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;gap:12px;z-index:5}
  .meta-play-result h2{color:var(--yellow);font-size:28px}
  .meta-play-result p{font-size:18px}

  @media(max-width:960px){
    .meta-editor-layout{flex-direction:column}
    .meta-right{width:100%;position:static}
    .meta-head{flex-direction:column}
    .meta-head-preview{width:100%}
  }
  `;
  document.head.appendChild(st);
}

// ---------- создание DOM страницы ----------
function buildPage(){
  if($('metaPage')) return;
  const div = document.createElement('div');
  div.id = 'metaPage';
  div.className = 'page';
  div.innerHTML = `
    <div class="meta-top">
      <button class="btn btn-profile" id="metaBack">← Назад</button>
      <h2 style="color:var(--yellow);margin:0;flex:1">Метаредактор</h2>
      <button class="btn btn-profile" id="metaModeEdit">✏️ Редактор</button>
      <button class="btn btn-profile" id="metaModeDesign">🎨 Оформление</button>
      <button class="btn btn-profile" id="metaModePlay">▶ Предпросмотр</button>
      <button class="btn btn-profile" id="metaFullscreen">⛶</button>
    </div>

    <div class="meta-head" id="metaHead">
      <div class="meta-head-fields">
        <div class="field"><label>Название</label><input id="metaTitle" maxlength="60" placeholder="Название проекта"></div>
        <div class="field"><label>Описание</label><textarea id="metaDesc" rows="2" maxlength="160" placeholder="Коротко о проекте"></textarea></div>
        <div class="field"><label>Картинка-превью</label><div class="img-row"><input type="file" id="metaAvaFile" accept="image/*"><img class="thumb" id="metaAvaPreview" style="display:none"></div></div>
        <div class="meta-top" style="margin-top:8px">
          <button class="btn btn-profile" id="metaSaveDraft">💾 Сохранить</button>
          <button class="btn btn-create" id="metaPublish">🚀 Опубликовать</button>
          <button class="btn btn-profile" id="metaExport">⬇ Экспорт JSON</button>
          <button class="btn btn-profile" id="metaImportBtn">⬆ Импорт JSON</button>
          <input type="file" id="metaImportFile" accept="application/json" style="display:none">
        </div>
        <div class="meta-msg" id="metaMsg"></div>
      </div>
      <div class="meta-head-preview">
        <div class="meta-card">
          <div class="test-icon" id="metaPvIcon">✨</div>
          <h3 id="metaPvTitle">Название</h3>
          <div class="desc" id="metaPvDesc">Описание</div>
        </div>
      </div>
    </div>

    <div class="meta-editor-layout">
      <div class="meta-editor-main">
        <div class="meta-canvas-wrap" id="metaCanvasWrap">
          <div class="meta-canvas" id="metaCanvas">
            <div class="meta-canvas-inner" id="metaCanvasInner"></div>
          </div>
        </div>
        <div class="meta-toolbar" id="metaToolbar"></div>
        <div id="metaErrors"></div>
      </div>
      <div class="meta-right" id="metaRight">
        <div class="meta-empty">Выбери блок или элемент на полотне</div>
      </div>
    </div>

    <div class="meta-pop" id="metaPop"></div>
  `;
  document.body.appendChild(div);
}

// ---------- рендер превью-карточки ----------
function renderPreviewCard(){
  const icon = $('metaPvIcon');
  if(M.project.avatar) icon.innerHTML = '<img src="' + esc(M.project.avatar) + '">';
  else icon.textContent = '✨';
  $('metaPvTitle').textContent = M.project.title || 'Название';
  $('metaPvDesc').textContent = M.project.description || 'Описание';
}

// ---------- рендер тулбара ----------
function renderToolbar(){
  const tb = $('metaToolbar');
  tb.innerHTML = '';
  // блок
  const gBlock = document.createElement('div');
  gBlock.className = 'meta-tb-group';
  gBlock.innerHTML = '<b>Блоки</b>';
  const bBlock = mkTbItem('block', '▭', 'Блок', 'block');
  gBlock.appendChild(bBlock);
  const bEnd = mkTbItem('end', '🏁', 'Концовка', 'block');
  gBlock.appendChild(bEnd);
  tb.appendChild(gBlock);

  // output
  const gOut = document.createElement('div');
  gOut.className = 'meta-tb-group';
  gOut.innerHTML = '<b>Аутпут</b>';
  ['text','desc','image'].forEach(t => gOut.appendChild(mkTbItem('el', ELEMENT_TYPES[t].icon, ELEMENT_TYPES[t].name, 'output', t)));
  tb.appendChild(gOut);

  // input
  const gIn = document.createElement('div');
  gIn.className = 'meta-tb-group';
  gIn.innerHTML = '<b>Инпут</b>';
  gIn.appendChild(mkTbItem('el', ELEMENT_TYPES.input_text.icon, ELEMENT_TYPES.input_text.name, 'input', 'input_text'));
  tb.appendChild(gIn);

  // logic
  const gLogic = document.createElement('div');
  gLogic.className = 'meta-tb-group';
  gLogic.innerHTML = '<b>Логика</b>';
  gLogic.appendChild(mkTbItem('el', ELEMENT_TYPES.compare.icon, ELEMENT_TYPES.compare.name, 'logic', 'compare'));
  tb.appendChild(gLogic);
}
function mkTbItem(kind, icon, label, cat, type){
  const d = document.createElement('div');
  d.className = 'meta-tb-item';
  d.dataset.cat = cat || '';
  d.dataset.kind = kind;
  if(type) d.dataset.type = type;
  d.innerHTML = '<span class="ico">' + esc(icon) + '</span><span>' + esc(label) + '</span>';
  d.draggable = true;
  d.addEventListener('dragstart', e => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', JSON.stringify({ kind, type, cat }));
    M.drag = { kind, type, cat };
  });
  return d;
}

// ---------- рендер полотна ----------
function renderCanvas(){
  const inner = $('metaCanvasInner');
  inner.innerHTML = '';
  // первый блок — start
  const blocks = M.project.data.blocks;
  if(blocks.length && !M.project.data.startBlockId) M.project.data.startBlockId = blocks[0].id;

  // SVG для линий
  const svgWrap = document.createElement('div');
  svgWrap.className = 'meta-lines';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 2000 1600');
  svg.setAttribute('preserveAspectRatio', 'none');
  svgWrap.appendChild(svg);
  inner.appendChild(svgWrap);
  M._svg = svg;

  // блоки
  blocks.forEach(b => inner.appendChild(renderBlockOnCanvas(b)));

  // стрелки
  renderLinks(svg);

  // drop-зона на всём полотне (для нового блока)
  inner.ondragover = e => { if(M.drag && M.drag.kind === 'block') e.preventDefault(); };
  inner.ondrop = e => {
    if(!M.drag || M.drag.kind !== 'block') return;
    e.preventDefault();
    const r = inner.getBoundingClientRect();
    const x = snap(e.clientX - r.left);
    const y = snap(e.clientY - r.top);
    addBlock(M.drag.type === 'end', x, y);
    M.drag = null;
  };
  inner.addEventListener('click', e => {
    if(e.target === inner || e.target === svgWrap || e.target === svg){
      M.selectedBlockId = null; M.selectedElId = null;
      renderCanvas(); renderRightPanel(); renderErrors();
    }
  });
}

function renderBlockOnCanvas(b){
  const d = document.createElement('div');
  d.className = 'meta-block' + (M.selectedBlockId === b.id ? ' sel' : '') +
    (M.project.data.startBlockId === b.id ? ' start' : '') +
    (b.end ? ' end' : '');
  d.style.left = b.x + 'px';
  d.style.top = b.y + 'px';
  d.style.width = BLOCK_W + 'px';
  d.style.height = BLOCK_H + 'px';
  d.dataset.blockId = b.id;

  const title = b.end ? '🏁 Концовка' : ('Блок ' + (b.title || ''));
  d.innerHTML = '<div class="mb-title"><span>' + esc(title) + '</span><span>' + esc(b.id.slice(0,4)) + '</span></div>' +
    '<div class="mb-body" id="mbb-' + b.id + '">' +
      (b.bg ? '<div class="mb-body-img" style="background-image:url(' + esc(b.bg) + ')"></div>' : '') +
    '</div>';

  // элементы
  const body = d.querySelector('.mb-body');
  b.elements.forEach(el => body.appendChild(renderElOnCanvas(b, el)));

  // drag блока — только за заголовок
  const header = d.querySelector('.mb-title');
  header.style.pointerEvents = 'auto';
  header.style.cursor = 'move';
  header.addEventListener('pointerdown', e => {
    if(e.target.closest('.me-id')) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY, bx = b.x, by = b.y;
    const move = ev => {
      b.x = snap(bx + (ev.clientX - startX));
      b.y = snap(by + (ev.clientY - startY));
      d.style.left = b.x + 'px'; d.style.top = b.y + 'px';
      renderLinks(M._svg);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      M.dirty = true;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // клик на блок — выбрать
  d.addEventListener('mousedown', e => {
    if(e.target.closest('.me-id')) return;
    if(e.target.closest('.meta-el')) return;
    if(e.button !== 0) return;
    M.selectedBlockId = b.id; M.selectedElId = null;
    renderCanvas(); renderRightPanel(); renderErrors();
  });

  // drop элементов в блок
  body.addEventListener('dragover', e => {
    if(M.drag && M.drag.kind === 'el') e.preventDefault();
  });
  body.addEventListener('drop', e => {
    if(!M.drag || M.drag.kind !== 'el') return;
    e.preventDefault();
    const r = body.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    addElement(b.id, M.drag.type, M.drag.cat, px, py);
    M.drag = null;
  });

  return d;
}

function renderElOnCanvas(b, el){
  const d = document.createElement('div');
  const connected = el.type === 'input_text' ? isInputConnected(el.id) : false;
  const bad = el.type === 'input_text' && !connected;
  d.className = 'meta-el' + (M.selectedElId === el.id ? ' sel' : '') + (bad ? ' bad' : '');
  d.style.left = el.x + 'px';
  d.style.top = el.y + 'px';
  d.style.width = el.w + 'px';
  d.style.height = el.h + 'px';
  d.dataset.blockId = b.id;
  d.dataset.elId = el.id;

  const def = ELEMENT_TYPES[el.type];
  const idColor = connected ? ' ok' : '';
  d.innerHTML = '<span class="me-id' + idColor + '" title="Клик — копировать id">' + esc(el.id.slice(0,4)) + '</span>' +
    (el.type === 'input_text' ? '<span class="me-dot" title="Потяни к «Сравнению»"></span>' : '') +
    '<div class="me-body">' + def.render(el, { play: false }) + '</div>';

  // id click
  d.querySelector('.me-id').addEventListener('click', e => {
    e.stopPropagation();
    const text = el.id;
    if(navigator.clipboard) navigator.clipboard.writeText(text).then(() => {
      const idEl = e.target;
      idEl.textContent = '✓';
      setTimeout(() => { idEl.textContent = el.id.slice(0,4); }, 700);
    });
  });

  // drag элемента
  d.addEventListener('mousedown', e => {
    if(e.target.closest('.me-id') || e.target.closest('.me-dot')) return;
    if(e.button !== 0) return;
    e.preventDefault();
    M.selectedBlockId = b.id; M.selectedElId = el.id;
    renderRightPanel(); renderErrors();
    d.classList.add('sel');
    const startX = e.clientX, startY = e.clientY, ox = el.x, oy = el.y;
    const move = ev => {
      const nx = snap(ox + (ev.clientX - startX));
      const ny = snap(oy + (ev.clientY - startY));
      el.x = nx; el.y = ny;
      d.style.left = nx + 'px'; d.style.top = ny + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // валидация: в блоке или нет, не пересекается ли
      const test = { id: el.id, x: el.x, y: el.y, w: el.w, h: el.h };
      if(!fitsInBlock(test) || collides(b, test)){
        el.x = ox; el.y = oy;
        d.style.left = ox + 'px'; d.style.top = oy + 'px';
      } else {
        M.dirty = true;
      }
      renderErrors();
      renderRightPanel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // стрелка от инпута (data-link)
  const dot = d.querySelector('.me-dot');
  if(dot) dot.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    startDataLinkDrag(b.id, el.id, e);
  });

  return d;
}

// ---------- data-link: тянем от инпута к compare ----------
function startDataLinkDrag(fromBlockId, fromElId, e){
  const svg = M._svg;
  if(!svg) return;
  const tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  tempLine.setAttribute('stroke', '#d0162c');
  tempLine.setAttribute('stroke-width', '2');
  tempLine.setAttribute('stroke-dasharray', '5 4');
  tempLine.setAttribute('fill', 'none');
  svg.appendChild(tempLine);

  // найти все compare во всех блоках
  const compares = [];
  M.project.data.blocks.forEach(b => b.elements.forEach(el => {
    if(el.type === 'compare'){
      const elNode = document.querySelector('[data-el-id="' + el.id + '"] .me-id');
      if(elNode){
        const r = elNode.getBoundingClientRect();
        compares.push({ blockId: b.id, elId: el.id, cx: r.left + r.width/2, cy: r.top + r.height/2 });
      }
    }
  }));

  const canvas = $('metaCanvasInner');
  const fromNode = document.querySelector('[data-el-id="' + fromElId + '"] .me-dot');
  if(!fromNode){ tempLine.remove(); return; }
  const startRect = fromNode.getBoundingClientRect();

  const move = ev => {
    const r = canvas.getBoundingClientRect();
    const x1 = startRect.left + startRect.width/2 - r.left;
    const y1 = startRect.top + startRect.height/2 - r.top;
    const x2 = ev.clientX - r.left;
    const y2 = ev.clientY - r.top;
    tempLine.setAttribute('d', 'M' + x1 + ',' + y1 + ' Q' + ((x1+x2)/2) + ',' + ((y1+y2)/2) + ' ' + x2 + ',' + y2);
  };
  const up = ev => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    tempLine.remove();
    // найти ближайший compare в радиусе 80px
    let best = null, bd = 80;
    compares.forEach(c => {
      const d = Math.hypot(c.cx - ev.clientX, c.cy - ev.clientY);
      if(d < bd){ bd = d; best = c; }
    });
    if(best){
      // удалить старую связь от этого инпута, если была
      M.project.data.links = M.project.data.links.filter(l => !(l.kind === 'data' && l.from === fromElId));
      M.project.data.links.push({ id: uid(), kind: 'data', from: fromElId, to: 'cmp:' + best.blockId + ':' + best.elId });
      M.dirty = true;
      renderCanvas(); renderRightPanel(); renderErrors();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ---------- block-link: тянем от блока к блоку (стрелки переходов) ----------
// реализуем через кнопку в правой панели "Добавить переход" (проще и надёжнее)

// ---------- рендер линий/стрелок ----------
function renderLinks(svg){
  if(!svg) return;
  // очистить всё кроме defs
  while(svg.firstChild) svg.removeChild(svg.firstChild);
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id','meta-arrow');
  marker.setAttribute('viewBox','0 0 10 10');
  marker.setAttribute('refX','8');
  marker.setAttribute('refY','5');
  marker.setAttribute('markerWidth','8');
  marker.setAttribute('markerHeight','8');
  marker.setAttribute('orient','auto');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  poly.setAttribute('points','0,0 10,5 0,10');
  poly.setAttribute('fill','#888');
  marker.appendChild(poly);
  defs.appendChild(marker);
  svg.appendChild(defs);

  const inner = $('metaCanvasInner');
  const innerRect = inner.getBoundingClientRect();

  function blockCenter(b){
    return { x: b.x + BLOCK_W, y: b.y + BLOCK_H/2 };
  }
  function blockLeft(b){
    return { x: b.x, y: b.y + BLOCK_H/2 };
  }
  function elCenter(el){
    const node = document.querySelector('[data-el-id="' + el.id + '"]');
    if(!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.left - innerRect.left + r.width, y: r.top - innerRect.top + r.height/2 };
  }
  function cmpLeft(cmpEl){
    const node = document.querySelector('[data-el-id="' + cmpEl.id + '"]');
    if(!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.left - innerRect.left, y: r.top - innerRect.top + r.height/2 };
  }

  // block -> block (transitions)
  M.project.data.links.filter(l => l.kind === 'transition').forEach(l => {
    const fb = findBlock(l.from);
    const tb = findBlock(l.to);
    if(!fb || !tb) return;
    const a = blockCenter(fb), b = blockLeft(tb);
    drawArrow(svg, a, b, 'meta-link-line', false);
  });

  // input -> compare (data)
  M.project.data.links.filter(l => l.kind === 'data').forEach(l => {
    const input = (() => {
      for(const bl of M.project.data.blocks){
        const el = bl.elements.find(e => e.id === l.from);
        if(el) return el;
      }
      return null;
    })();
    if(!input) return;
    if(!l.to || !l.to.startsWith('cmp:')) return;
    const [, cmpBlockId, cmpId] = l.to.split(':');
    const cmp = findElement(cmpBlockId, cmpId);
    if(!cmp) return;
    const a = elCenter(input), b = cmpLeft(cmp);
    if(a && b) drawArrow(svg, a, b, 'meta-link-line data', true);
  });
}

function drawArrow(svg, a, b, cls, dash){
  const midX = (a.x + b.x) / 2;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M' + a.x + ',' + a.y + ' C' + midX + ',' + a.y + ' ' + midX + ',' + b.y + ' ' + b.x + ',' + b.y);
  path.setAttribute('class', cls);
  path.setAttribute('marker-end', 'url(#meta-arrow)');
  svg.appendChild(path);
}

// ---------- добавление блока / элемента ----------
function addBlock(isEnd, x, y){
  const id = uid();
  const b = { id, x: x || 100, y: y || 100, title: '', bg: '', end: !!isEnd, elements: [] };
  M.project.data.blocks.push(b);
  if(!M.project.data.startBlockId) M.project.data.startBlockId = id;
  M.selectedBlockId = id; M.selectedElId = null;
  M.dirty = true;
  renderCanvas(); renderRightPanel(); renderErrors();
}

function addElement(blockId, type, cat, px, py){
  const b = findBlock(blockId);
  if(!b) return;
  const def = ELEMENT_TYPES[type];
  if(!def) return;
  const size = def.defaultSize || { w: 200, h: 40 };
  let x = snap(px - size.w/2);
  let y = snap(py - size.h/2);
  if(x < 0) x = 0;
  if(y < 0) y = 0;
  if(x + size.w > BLOCK_W) x = snap(BLOCK_W - size.w);
  if(y + size.h > BLOCK_H) y = snap(BLOCK_H - size.h);
  // подобрать свободное место
  let attempt = { id: uid(), type, cat, x, y, w: size.w, h: size.h, props: JSON.parse(JSON.stringify(def.props || {})) };
  if(collides(b, attempt)){
    // сдвигаем вниз по сетке
    for(let ny = 0; ny + attempt.h <= BLOCK_H; ny += GRID){
      for(let nx = 0; nx + attempt.w <= BLOCK_W; nx += GRID){
        const t = Object.assign({}, attempt, { x: nx, y: ny });
        if(!collides(b, t) && fitsInBlock(t)){ attempt.x = nx; attempt.y = ny; ny = BLOCK_H; break; }
      }
    }
  }
  b.elements.push(attempt);
  M.selectedBlockId = blockId; M.selectedElId = attempt.id;
  M.dirty = true;
  renderCanvas(); renderRightPanel(); renderErrors();
}

// ---------- правая панель ----------
function renderRightPanel(){
  const box = $('metaRight');
  box.innerHTML = '';
  if(M.selectedElId){
    const bl = M.project.data.blocks.find(x => x.elements.some(e => e.id === M.selectedElId));
    const el = bl ? bl.elements.find(e => e.id === M.selectedElId) : null;
    if(el && bl){ renderElPanel(box, bl, el); return; }
  }
  if(M.selectedBlockId){
    const b = findBlock(M.selectedBlockId);
    if(b){ renderBlockPanel(box, b); return; }
  }
  box.innerHTML = '<div class="meta-empty">Выбери блок или элемент на полотне</div>';
}

function renderBlockPanel(box, b){
  box.innerHTML = '<h3>' + (b.end ? '🏁 Концовка' : 'Блок') + '</h3>' +
    '<div class="field"><label>Название (для тебя)</label><input id="mb-title" maxlength="40" value="' + esc(b.title || '') + '"></div>' +
    '<div class="field"><label>Фон</label><div class="img-row"><input type="file" id="mb-bg-file" accept="image/*">' + (b.bg ? '<img class="thumb" src="' + esc(b.bg) + '">' : '') + '</div></div>' +
    '<div class="field"><label>Исходящий переход</label>' + renderTransitionEditor(b) + '</div>' +
    (M.project.data.startBlockId === b.id ? '<div class="meta-hint">Это стартовый блок.</div>' : '<button class="btn btn-profile" id="mb-set-start" style="width:100%;margin-top:6px">Сделать стартовым</button>') +
    '<button class="meta-danger" id="mb-del" style="width:100%;margin-top:10px">Удалить блок</button>' +
    '<div class="meta-hint">id: ' + esc(b.id) + '</div>';

  $('mb-title').addEventListener('input', e => { b.title = e.target.value; M.dirty = true; renderCanvas(); });
  $('mb-bg-file').addEventListener('change', async e => {
    const f = e.target.files[0]; if(!f) return;
    try { b.bg = await uploadMetaImage(f); M.dirty = true; renderCanvas(); renderRightPanel(); }
    catch(err){ alert('Ошибка загрузки: ' + err.message); }
  });
  if($('mb-set-start')) $('mb-set-start').addEventListener('click', () => {
    M.project.data.startBlockId = b.id; M.dirty = true; renderCanvas(); renderRightPanel();
  });
  $('mb-del').addEventListener('click', () => {
    if(!confirm('Удалить блок и все его элементы?')) return;
    M.project.data.blocks = M.project.data.blocks.filter(x => x.id !== b.id);
    M.project.data.links = M.project.data.links.filter(l => l.from !== b.id && l.to !== b.id);
    if(M.project.data.startBlockId === b.id) M.project.data.startBlockId = M.project.data.blocks[0] ? M.project.data.blocks[0].id : null;
    M.selectedBlockId = null; M.selectedElId = null;
    M.dirty = true;
    renderCanvas(); renderRightPanel(); renderErrors();
  });
  // transition editor
  bindTransitionEditor(b);
}

function renderTransitionEditor(b){
  const outLinks = M.project.data.links.filter(l => l.kind === 'transition' && l.from === b.id);
  if(b.end) return '<div class="meta-hint">Концовка — переходов нет.</div>';
  let h = '';
  outLinks.forEach(l => {
    const target = findBlock(l.to);
    h += '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
      '<span style="font-size:12px">→ ' + esc(target ? (target.title || target.id.slice(0,4)) : '?') + '</span>' +
      '<select class="tr-op" data-link="' + l.id + '" style="width:60px"><option value="">—</option>' +
        ['=', '≠', '>', '<', '≥', '≤'].map(op => '<option value="' + op + '"' + (l.condition && l.condition.op === op ? ' selected' : '') + '>' + op + '</option>').join('') + '</select>' +
      '<input type="number" class="tr-val" data-link="' + l.id + '" value="' + (l.condition ? l.condition.value : 0) + '" style="width:60px">' +
      '<button class="meta-danger tr-del" data-link="' + l.id + '" style="padding:2px 6px">✕</button>' +
    '</div>';
  });
  const others = M.project.data.blocks.filter(x => x.id !== b.id && !x.end);
  h += '<select id="mb-newlink" style="width:100%;padding:6px;margin-top:4px;border:2px solid #e2e2e2;border-radius:6px"><option value="">+ переход к…</option>' +
    others.map(x => '<option value="' + x.id + '">' + esc(x.title || ('Блок ' + x.id.slice(0,4))) + '</option>').join('') + '</select>';
  const ends = M.project.data.blocks.filter(x => x.id !== b.id && x.end);
  if(ends.length){
    h += '<select id="mb-newlink-end" style="width:100%;padding:6px;margin-top:4px;border:2px solid #e2e2e2;border-radius:6px"><option value="">+ переход к концовке…</option>' +
      ends.map(x => '<option value="' + x.id + '">' + esc(x.title || ('Концовка ' + x.id.slice(0,4))) + '</option>').join('') + '</select>';
  }
  return h;
}

function bindTransitionEditor(b){
  document.querySelectorAll('.tr-op').forEach(s => s.addEventListener('change', e => {
    const l = M.project.data.links.find(x => x.id === e.target.dataset.link);
    if(!l) return;
    const op = e.target.value;
    if(!op){ delete l.condition; }
    else {
      const cur = l.condition || { value: 0 };
      l.condition = { op, value: Number(cur.value) || 0 };
    }
    M.dirty = true; renderCanvas();
  }));
  document.querySelectorAll('.tr-val').forEach(inp => inp.addEventListener('input', e => {
    const l = M.project.data.links.find(x => x.id === e.target.dataset.link);
    if(!l) return;
    if(l.condition){ l.condition.value = Number(e.target.value) || 0; M.dirty = true; }
  }));
  document.querySelectorAll('.tr-del').forEach(btn => btn.addEventListener('click', e => {
    const lid = e.target.dataset.link;
    M.project.data.links = M.project.data.links.filter(x => x.id !== lid);
    M.dirty = true; renderCanvas(); renderRightPanel();
  }));
  const nl = $('mb-newlink');
  if(nl) nl.addEventListener('change', e => {
    if(!e.target.value) return;
    M.project.data.links.push({ id: uid(), kind: 'transition', from: b.id, to: e.target.value, condition: null });
    M.dirty = true; renderCanvas(); renderRightPanel();
  });
  const nle = $('mb-newlink-end');
  if(nle) nle.addEventListener('change', e => {
    if(!e.target.value) return;
    M.project.data.links.push({ id: uid(), kind: 'transition', from: b.id, to: e.target.value, condition: null });
    M.dirty = true; renderCanvas(); renderRightPanel();
  });
}

function renderElPanel(box, bl, el){
  const def = ELEMENT_TYPES[el.type];
  let h = '<h3>' + esc(def.name) + '</h3>';
  h += '<div class="field"><label>id</label><input value="' + esc(el.id) + '" readonly></div>';

  if(el.type === 'text' || el.type === 'desc'){
    h += '<div class="field"><label>Содержимое</label><textarea id="me-text" rows="4">' + esc(el.props.text || '') + '</textarea></div>';
  }
  if(el.type === 'image'){
    h += '<div class="field"><label>Картинка</label><div class="img-row"><input type="file" id="me-img-file" accept="image/*">' +
      (el.props.url ? '<img class="thumb" src="' + esc(el.props.url) + '">' : '') + '</div></div>';
  }
  if(el.type === 'input_text'){
    h += '<div class="field"><label>Placeholder</label><input id="me-ph" value="' + esc(el.props.placeholder || '') + '"></div>';
    const cmp = findCompareForInput(el.id);
    h += '<div class="meta-hint">' + (cmp ? '✅ Подключён к сравнению' : '⚠️ Не подключён: потяни оранжевую точку к «Сравнению»') + '</div>';
  }
  if(el.type === 'compare'){
    h += '<div class="field"><label>Варианты ответа</label><div id="me-variants">';
    (el.props.variants || []).forEach((v, i) => {
      h += '<div class="meta-cmp-edit"><input type="text" data-vi="' + i + '" class="mv-text" value="' + esc(v.text || '') + '" placeholder="эталон">' +
        '<input type="number" data-vi="' + i + '" class="mv-pts" value="' + (Number(v.points) || 0) + '">' +
        '<button class="meta-danger mv-del" data-vi="' + i + '" style="padding:0 6px">✕</button></div>';
    });
    h += '</div><button class="btn btn-profile" id="me-add-var" style="width:100%;margin-top:6px">+ Вариант</button></div>';
    h += '<div class="field"><label>Подключённые инпуты</label><div>';
    const inputs = M.project.data.links.filter(l => l.kind === 'data' && l.to === 'cmp:' + bl.id + ':' + el.id);
    if(!inputs.length) h += '<span class="meta-muted">нет</span>';
    else h += inputs.map(l => '<div class="meta-hint">→ ' + esc(l.from.slice(0,6)) + '</div>').join('');
    h += '</div></div>';
  }

  h += '<button class="meta-danger" id="me-del" style="width:100%;margin-top:12px">Удалить элемент</button>';
  box.innerHTML = h;

  if(el.type === 'text' || el.type === 'desc'){
    $('me-text').addEventListener('input', e => { el.props.text = e.target.value; M.dirty = true; renderCanvas(); });
  }
  if(el.type === 'image'){
    $('me-img-file').addEventListener('change', async e => {
      const f = e.target.files[0]; if(!f) return;
      try { el.props.url = await uploadMetaImage(f); M.dirty = true; renderCanvas(); renderRightPanel(); }
      catch(err){ alert(err.message); }
    });
  }
  if(el.type === 'input_text'){
    $('me-ph').addEventListener('input', e => { el.props.placeholder = e.target.value; M.dirty = true; renderCanvas(); });
  }
  if(el.type === 'compare'){
    box.querySelectorAll('.mv-text').forEach(inp => inp.addEventListener('input', e => {
      const i = Number(e.target.dataset.vi);
      el.props.variants[i].text = e.target.value; M.dirty = true; renderCanvas();
    }));
    box.querySelectorAll('.mv-pts').forEach(inp => inp.addEventListener('input', e => {
      const i = Number(e.target.dataset.vi);
      el.props.variants[i].points = Number(e.target.value) || 0; M.dirty = true; renderCanvas();
    }));
    box.querySelectorAll('.mv-del').forEach(b => b.addEventListener('click', e => {
      const i = Number(e.target.dataset.vi);
      el.props.variants.splice(i, 1); M.dirty = true; renderCanvas(); renderRightPanel();
    }));
    $('me-add-var').addEventListener('click', () => {
      el.props.variants = el.props.variants || [];
      el.props.variants.push({ text: '', points: 0 });
      M.dirty = true; renderRightPanel(); renderCanvas();
    });
  }
  $('me-del').addEventListener('click', () => {
    if(!confirm('Удалить элемент?')) return;
    bl.elements = bl.elements.filter(x => x.id !== el.id);
    M.project.data.links = M.project.data.links.filter(l => l.from !== el.id && l.to !== ('cmp:' + bl.id + ':' + el.id));
    M.selectedElId = null;
    M.dirty = true; renderCanvas(); renderRightPanel(); renderErrors();
  });
}

// ---------- валидация ----------
function collectErrors(){
  const errs = [];
  const data = M.project.data;
  if(!data.blocks.length) errs.push('Нет ни одного блока');
  if(!data.startBlockId) errs.push('Не выбран стартовый блок');
  data.blocks.forEach(b => {
    if(!b.end){
      const outs = data.links.filter(l => l.kind === 'transition' && l.from === b.id);
      if(!outs.length) errs.push('Блок «' + (b.title || b.id.slice(0,4)) + '» без исходящего перехода');
    }
    b.elements.forEach(el => {
      if(el.type === 'input_text' && !isInputConnected(el.id)){
        errs.push('Инпут ' + el.id.slice(0,4) + ' не подключён к сравнению');
      }
      if(el.type === 'compare'){
        const hasInput = data.links.some(l => l.kind === 'data' && l.to === 'cmp:' + b.id + ':' + el.id);
        if(!hasInput) errs.push('Сравнение ' + el.id.slice(0,4) + ' не подключено ни к одному инпуту');
      }
    });
  });
  return errs;
}

function renderErrors(){
  const box = $('metaErrors');
  if(!box) return;
  const errs = collectErrors();
  if(!errs.length){ box.innerHTML = ''; return; }
  box.innerHTML = '<div class="meta-errors"><b>Проблемы (' + errs.length + '):</b><ul>' +
    errs.map(e => '<li>' + esc(e) + '</li>').join('') + '</ul></div>';
}

// ---------- обработчики шапки ----------
function bindHeader(){
  $('metaTitle').addEventListener('input', e => { M.project.title = e.target.value; M.dirty = true; renderPreviewCard(); });
  $('metaDesc').addEventListener('input', e => { M.project.description = e.target.value; M.dirty = true; renderPreviewCard(); });
  $('metaAvaFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if(!f) return;
    try {
      const url = await uploadMetaImage(f);
      M.project.avatar = url; M.dirty = true;
      const p = $('metaAvaPreview'); p.src = url; p.style.display = 'block';
      renderPreviewCard();
    } catch(err){ alert(err.message); }
  });

  $('metaSaveDraft').addEventListener('click', async () => {
    const m = $('metaMsg'); m.className = 'meta-msg'; m.textContent = 'Сохраняем…';
    try {
      await saveProject(M.project.published);
      m.classList.add('ok'); m.textContent = 'Черновик сохранён';
    } catch(err){ m.classList.add('err'); m.textContent = 'Ошибка: ' + err.message; }
  });

  $('metaPublish').addEventListener('click', async () => {
    const m = $('metaMsg'); m.className = 'meta-msg';
    const errs = collectErrors();
    if(!M.project.title.trim()){ m.classList.add('err'); m.textContent = 'Введите название'; return; }
    if(errs.length){ m.classList.add('err'); m.textContent = 'Исправьте ошибки (' + errs.length + ') перед публикацией'; return; }
    m.textContent = 'Публикуем…';
    try {
      await saveProject(true);
      m.classList.add('ok'); m.textContent = 'Опубликовано!';
    } catch(err){ m.classList.add('err'); m.textContent = 'Ошибка: ' + err.message; }
  });

  $('metaExport').addEventListener('click', exportJSON);
  $('metaImportBtn').addEventListener('click', () => $('metaImportFile').click());
  $('metaImportFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if(!f) return;
    try {
      await importJSON(f);
      M.selectedBlockId = null; M.selectedElId = null;
      loadToUI();
      renderCanvas(); renderRightPanel(); renderErrors();
      $('metaMsg').className = 'meta-msg ok'; $('metaMsg').textContent = 'Импортировано';
    } catch(err){ $('metaMsg').className = 'meta-msg err'; $('metaMsg').textContent = 'Ошибка импорта: ' + err.message; }
    e.target.value = '';
  });

  $('metaBack').addEventListener('click', () => { location.hash = ''; });
  $('metaFullscreen').addEventListener('click', () => {
    M.fullscreen = !M.fullscreen;
    $('metaCanvasWrap').classList.toggle('fs', M.fullscreen);
    $('metaFullscreen').textContent = M.fullscreen ? '✕' : '⛶';
  });
  $('metaModeEdit').addEventListener('click', () => setMode('edit'));
  $('metaModeDesign').addEventListener('click', () => setMode('design'));
  $('metaModePlay').addEventListener('click', () => setMode('play'));
}

function setMode(mode){
  M.mode = mode;
  ['metaModeEdit','metaModeDesign','metaModePlay'].forEach(id => $(id).style.background = '');
  if(mode === 'edit') $('metaModeEdit').style.background = 'var(--yellow)';
  if(mode === 'design') $('metaModeDesign').style.background = 'var(--yellow)';
  if(mode === 'play') $('metaModePlay').style.background = 'var(--yellow)';
  if(mode === 'play') startPlayPreview();
  else { stopPlayPreview(); renderCanvas(); renderRightPanel(); renderErrors(); }
}

// заглушка — реальный play в части 3
function startPlayPreview(){ if(window.META._startPlay) window.META._startPlay(); }
function stopPlayPreview(){ if(window.META._stopPlay) window.META._stopPlay(); }

// ---------- заполнить UI из M.project ----------
function loadToUI(){
  $('metaTitle').value = M.project.title || '';
  $('metaDesc').value = M.project.description || '';
  const p = $('metaAvaPreview');
  if(M.project.avatar){ p.src = M.project.avatar; p.style.display = 'block'; }
  else { p.style.display = 'none'; p.removeAttribute('src'); }
  renderPreviewCard();
}

// ---------- открыть страницу проекта ----------
async function openProjectPage(id){
  injectStyles();
  buildPage();
  if(!window.currentUser){
    alert('Войдите, чтобы открыть метаредактор');
    location.hash = '';
    return;
  }
  if(id){
    try {
      const p = await loadProject(id);
      if(!p){ alert('Проект не найден'); location.hash = '#/meta'; return; }
      M.project = p;
    } catch(err){ alert('Ошибка: ' + err.message); location.hash = ''; return; }
  } else {
    M.project = newProject();
  }
  M.selectedBlockId = null; M.selectedElId = null; M.mode = 'edit';
  window.showPage('metaPage');
  loadToUI();
  renderToolbar();
  renderCanvas();
  renderRightPanel();
  renderErrors();
  setMode('edit');
  bindHeaderOnce();
}

let headerBound = false;
function bindHeaderOnce(){
  if(headerBound) return;
  headerBound = true;
  bindHeader();
}

// ---------- страница "мои проекты" ----------
async function openProjectsPage(){
  injectStyles();
  // используем kindPage-подобную структуру — создадим свою страницу
  if(!$('metaListPage')){
    const div = document.createElement('div');
    div.id = 'metaListPage';
    div.className = 'page';
    div.innerHTML = '<h2 style="color:var(--yellow);margin-bottom:20px">Метаредактор: мои проекты</h2>' +
      '<button class="btn btn-create" id="metaNewBtn" style="margin-bottom:16px">+ Создать проект</button>' +
      '<div class="grid" id="metaProjectsGrid"></div>';
    document.body.appendChild(div);
    $('metaNewBtn').addEventListener('click', () => { location.hash = '#/meta/new'; });
  }
  window.showPage('metaListPage');
  const grid = $('metaProjectsGrid');
  grid.innerHTML = '<p style="color:rgba(255,255,255,.8)">Загрузка…</p>';
  if(!window.currentUser){ grid.innerHTML = '<p style="color:rgba(255,255,255,.8)">Войдите, чтобы видеть свои проекты</p>'; return; }
  try {
    const list = await listMyProjects();
    grid.innerHTML = '';
    if(!list.length){ grid.innerHTML = '<p style="color:rgba(255,255,255,.8)">Пока нет проектов. Создайте первый!</p>'; return; }
    list.forEach(p => {
      const card = document.createElement('div');
      card.className = 'meta-card';
      const icon = p.avatar ? '<img src="' + esc(p.avatar) + '">' : '✨';
      card.innerHTML = '<div class="test-icon">' + icon + '</div>' +
        '<h3>' + esc(p.title || 'Без названия') + '</h3>' +
        '<div class="desc">' + (p.published ? '✅ опубликован' : '📝 черновик') + '</div>' +
        '<div style="display:flex;gap:6px;margin-top:10px;width:100%">' +
        '<button class="btn btn-create" style="flex:1" data-act="edit">Открыть</button>' +
        (p.published ? '<button class="btn btn-profile" style="flex:0 0 auto" data-act="play">▶</button>' : '') +
        '</div>';
      card.querySelector('[data-act="edit"]').addEventListener('click', e => {
        e.stopPropagation(); location.hash = '#/meta/edit/' + p.id;
      });
      if(p.published){
        card.querySelector('[data-act="play"]').addEventListener('click', e => {
          e.stopPropagation(); location.hash = '#/meta/play/' + p.id;
        });
      }
      grid.appendChild(card);
    });
  } catch(err){ grid.innerHTML = '<p style="color:#fff">Ошибка: ' + esc(err.message) + '</p>'; }
}

// ============================================================
//   ЧАСТЬ 3: PLAY-РЕЖИМ, РОУТИНГ, ИНТЕГРАЦИЯ
// ============================================================

// ---------- нормализация текста (как normAns) ----------
function normAns(s){
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');
}

// ---------- состояние play ----------
const P = {
  project: null,
  blockId: null,
  score: 0,
  answers: {},   // elId -> value
  over: false,
  container: null,
  keyHandler: null
};

// ---------- старт предпросмотра (из редактора) ----------
window.META._startPlay = function(){
  const wrap = $('metaCanvasWrap');
  const canvas = $('metaCanvas');
  if(!M.project) return;
  // проверить ошибки
  const errs = collectErrors();
  if(errs.length){
    alert('Нельзя запустить: ' + errs.length + ' проблем. Исправьте их сначала (список под полотном).');
    return;
  }
  // скрыть редакторское полотно
  canvas.style.display = 'none';
  // создать play-контейнер
  let play = $('metaPlayBox');
  if(!play){
    play = document.createElement('div');
    play.id = 'metaPlayBox';
    play.className = 'meta-play';
    play.style.cssText = 'position:absolute;inset:0;';
    wrap.appendChild(play);
  }
  play.style.display = 'block';
  P.project = JSON.parse(JSON.stringify(M.project));
  P.blockId = M.project.data.startBlockId;
  P.score = 0;
  P.answers = {};
  P.over = false;
  P.container = play;
  renderPlayBlock();
};

window.META._stopPlay = function(){
  const play = $('metaPlayBox');
  if(play) play.style.display = 'none';
  const canvas = $('metaCanvas');
  if(canvas) canvas.style.display = '';
  P.project = null;
};

// ---------- рендер блока в play ----------
function renderPlayBlock(){
  const box = P.container;
  if(!box) return;
  box.innerHTML = '';
  if(P.over) return;

  const data = P.project.data;
  const b = data.blocks.find(x => x.id === P.blockId);
  if(!b){ showPlayEnd('Конец', 'Блок не найден'); return; }

  const inner = document.createElement('div');
  inner.className = 'meta-play-inner';
  if(b.bg) inner.style.backgroundImage = 'url(' + b.bg + ')';
  inner.style.position = 'absolute';
  inner.style.inset = '0';

  // масштаб: блок 800x600 -> контейнер
  const cw = box.clientWidth || 800;
  const ch = box.clientHeight || 600;
  const scale = Math.min(cw / BLOCK_W, ch / BLOCK_H);
  const offX = (cw - BLOCK_W * scale) / 2;
  const offY = (ch - BLOCK_H * scale) / 2;

  const stage = document.createElement('div');
  stage.style.cssText = 'position:absolute;width:' + BLOCK_W + 'px;height:' + BLOCK_H + 'px;left:' + offX + 'px;top:' + offY + 'px;transform:scale(' + scale + ');transform-origin:top left';

  b.elements.forEach(el => {
    const def = ELEMENT_TYPES[el.type];
    const node = document.createElement('div');
    node.className = 'meta-el';
    node.style.cssText = 'left:' + el.x + 'px;top:' + el.y + 'px;width:' + el.w + 'px;height:' + el.h + 'px;';
    node.innerHTML = '<div class="me-body">' + def.render(el, { play: true }) + '</div>';
    // оживить инпуты
    if(el.type === 'input_text'){
      const inp = node.querySelector('input');
      if(inp){
        inp.value = P.answers[el.id] || '';
        inp.addEventListener('input', () => { P.answers[el.id] = inp.value; });
      }
    }
    stage.appendChild(node);
  });

  inner.appendChild(stage);

  // кнопка "Далее"
  const btn = document.createElement('button');
  btn.className = 'btn btn-create';
  btn.textContent = 'Далее →';
  btn.style.cssText = 'position:absolute;right:20px;bottom:20px;z-index:10;font-size:18px;padding:12px 28px';
  btn.addEventListener('click', () => onNext(b));
  box.appendChild(inner);
  box.appendChild(btn);
}

function onNext(b){
  const data = P.project.data;
  // посчитать очки по сравнениям, подключённым к инпутам этого блока
  let addScore = 0;
  b.elements.forEach(el => {
    if(el.type !== 'input_text') return;
    const cmp = (() => {
      const link = data.links.find(l => l.kind === 'data' && l.from === el.id);
      if(!link) return null;
      const [, cbid, cid] = link.to.split(':');
      const cb = data.blocks.find(x => x.id === cbid);
      return cb ? cb.elements.find(e => e.id === cid) : null;
    })();
    if(!cmp) return;
    const val = normAns(P.answers[el.id] || '');
    if(!val) return;
    (cmp.props.variants || []).forEach(v => {
      if(normAns(v.text) === val) addScore += Number(v.points) || 0;
    });
  });
  P.score += addScore;

  // выбрать переход
  const outs = data.links.filter(l => l.kind === 'transition' && l.from === b.id);
  if(!outs.length){
    // если есть концовки — идём в первую
    const end = data.blocks.find(x => x.end);
    if(end){ P.blockId = end.id; renderPlayBlock(); return; }
    showPlayEnd('Конец', 'Очков: ' + P.score); return;
  }
  // фильтр по условию
  let chosen = null;
  for(const l of outs){
    if(!l.condition){ if(!chosen) chosen = l; continue; }
    if(testCond(l.condition, P.score)){ chosen = l; break; }
  }
  if(!chosen) chosen = outs[0];
  const target = data.blocks.find(x => x.id === chosen.to);
  if(!target){ showPlayEnd('Конец', 'Очков: ' + P.score); return; }
  if(target.end){ showPlayEnd(target.title || 'Финал', 'Вы набрали: ' + P.score + ' очков'); return; }
  P.blockId = target.id;
  renderPlayBlock();
}

function testCond(cond, score){
  if(!cond) return true;
  const v = Number(cond.value) || 0;
  switch(cond.op){
    case '=': return score === v;
    case '≠': return score !== v;
    case '>': return score > v;
    case '<': return score < v;
    case '≥': return score >= v;
    case '≤': return score <= v;
    default: return true;
  }
}

function showPlayEnd(title, sub){
  P.over = true;
  const box = P.container;
  if(!box) return;
  box.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'meta-play-result';
  d.innerHTML = '<h2>' + esc(title) + '</h2><p>' + esc(sub) + '</p>' +
    '<button class="btn btn-create" id="playRestart">Пройти заново</button>' +
    '<button class="btn btn-profile" id="playExit">Выйти из предпросмотра</button>';
  box.appendChild(d);
  $('playRestart').addEventListener('click', () => {
    P.blockId = P.project.data.startBlockId;
    P.score = 0; P.answers = {}; P.over = false;
    renderPlayBlock();
  });
  $('playExit').addEventListener('click', () => { window.META._stopPlay(); setMode('edit'); });
}

// ---------- страница прохождения (публичная) ----------
async function openPlayPage(projectId){
  injectStyles();
  if(!$('metaPlayPage')){
    const div = document.createElement('div');
    div.id = 'metaPlayPage';
    div.className = 'page';
    div.innerHTML = '<div style="max-width:1000px;margin:0 auto">' +
      '<div id="metaPlayHeader" style="text-align:center;color:#fff;margin-bottom:16px"></div>' +
      '<div id="metaPlayArea" style="position:relative;height:640px;background:#111;border-radius:16px;overflow:hidden"></div>' +
      '<div id="metaPlayFooter" style="text-align:center;margin-top:16px"></div>' +
      '</div>';
    document.body.appendChild(div);
  }
  window.showPage('metaPlayPage');
  $('metaPlayArea').innerHTML = '<p style="color:#fff;padding:24px">Загрузка…</p>';
  try {
    const p = await loadProject(projectId);
    if(!p){ alert('Проект не найден'); location.hash = ''; return; }
    P.project = p;
    P.blockId = p.data.startBlockId;
    P.score = 0; P.answers = {}; P.over = false;
    P.container = $('metaPlayArea');
    $('metaPlayHeader').innerHTML = '<h2 style="color:var(--yellow);font-size:28px">' + esc(p.title) + '</h2>' +
      (p.description ? '<p style="opacity:.85;margin-top:6px">' + esc(p.description) + '</p>' : '');
    renderPlayBlock();
    // кнопка выхода/домой
    $('metaPlayFooter').innerHTML = '<button class="btn btn-profile" onclick="goHome()">На главную</button>';
  } catch(err){
    $('metaPlayArea').innerHTML = '<p style="color:#fff;padding:24px">Ошибка: ' + esc(err.message) + '</p>';
  }
}

// ---------- роутинг ----------
window.metaRoute = function(h){
  // #/meta             — список моих проектов
  // #/meta/new         — новый
  // #/meta/edit/<id>   — редактировать
  // #/meta/play/<id>   — прохождение
  if(!h.startsWith('#/meta')) return false;
  if(h === '#/meta' || h === '#/meta/'){
    openProjectsPage();
    return true;
  }
  if(h === '#/meta/new'){
    openProjectPage(null);
    return true;
  }
  if(h.startsWith('#/meta/edit/')){
    const id = h.slice(11);
    openProjectPage(id);
    return true;
  }
  if(h.startsWith('#/meta/play/')){
    const id = h.slice(11);
    openPlayPage(id);
    return true;
  }
  openProjectsPage();
  return true;
};

// ---------- интеграция с главной: добавить метапроекты в общий список ----------
// Перехватываем openMainPage через свой хук: после того как основной код отрисовал
// тесты, дописываем карточки метапроектов в тот же #testGrid.
// Делаем аккуратно: ждём, пока основной скрипт отрисует, потом добавляем.
(function(){
  let busy = false;
  const origHash = () => location.hash;
  document.addEventListener('DOMContentLoaded', () => {});
  // перехват showPage — чтобы понять, когда открыта главная
  const tryInject = async () => {
    if(busy) return;
    const grid = $('testGrid');
    if(!grid) return;
    if(location.hash && location.hash !== '#/' && location.hash !== '') return;
    if(!grid.querySelectorAll('.card').length) return;
    if(grid.querySelector('.meta-card-home')) return; // уже добавили
    busy = true;
    try {
      const list = await listPublishedProjects();
      if(!list.length){ busy = false; return; }
      list.forEach(p => {
        const card = document.createElement('div');
        card.className = 'card meta-card-home';
        const icon = p.avatar ? '<img src="' + esc(p.avatar) + '">' : '✨';
        const author = p.profiles ? p.profiles.login : '???';
        card.innerHTML = '<div class="test-icon">' + icon + '</div>' +
          '<h3>' + esc(p.title) + '</h3>' +
          (p.description ? '<div class="desc">' + esc(p.description) + '</div>' : '') +
          '<div class="author">от ' + esc(author) + '</div>';
        card.addEventListener('click', () => { location.hash = '#/meta/play/' + p.id; });
        grid.appendChild(card);
      });
    } catch(_){}
    busy = false;
  };
  // перехватываем hashchange и через 400мс пробуем добавить (основной код уже отрисовал)
  window.addEventListener('hashchange', () => { setTimeout(tryInject, 450); });
  // на первой загрузке
  setTimeout(tryInject, 800);
})();

// ---------- кнопка «Метаредактор» в шапку ----------
(function(){
  const addBtn = () => {
    const nav = document.getElementById('navBox');
    if(!nav) return;
    if(nav.querySelector('.meta-nav-btn')) return;
    const btn = document.createElement('a');
    btn.href = '#/meta';
    btn.className = 'btn btn-nav meta-nav-btn';
    btn.textContent = 'Метаредактор';
    // вставляем в начало nav
    nav.insertBefore(btn, nav.firstChild);
  };
  // вызываем сейчас и при каждом renderNav (переопределяем)
  const tryOverride = () => {
    if(window.renderNav && !window.renderNav._metaWrapped){
      const orig = window.renderNav;
      window.renderNav = function(){
        orig.apply(this, arguments);
        addBtn();
      };
      window.renderNav._metaWrapped = true;
    }
  };
  // renderNav объявлена через function, доступна как глобальная
  if(typeof renderNav === 'function') tryOverride();
  // на всякий случай — по таймеру
  const t = setInterval(() => { tryOverride(); if(document.getElementById('navBox')) { addBtn(); clearInterval(t); } }, 200);
  setTimeout(addBtn, 1000);
})();

})();
