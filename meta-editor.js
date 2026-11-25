(function(){
'use strict';
const $ = id => document.getElementById(id);
const sb = window.sb;
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const BUCKET = 'meta-images', GRID = 20, BLOCK_W = 800, BLOCK_H = 600;

// Синхронизация пользователя
sb.auth.onAuthStateChange((event, session) => {
  window.currentUser = (session && session.user) ? session.user : null;
});
sb.auth.getSession().then(({data}) => {
  if(data && data.session) window.currentUser = data.session.user;
});

const ELEMENT_TYPES = {
  text: { category: 'output', name: 'Текст', icon: 'Т', defaultSize: { w: 320, h: 40 }, props: { text: '' }, render: (el) => `<div class="meta-text">${esc(el.props.text || '')}</div>` },
  desc: { category: 'output', name: 'Описание', icon: 'О', defaultSize: { w: 360, h: 60 }, props: { text: '' }, render: (el) => `<div class="meta-desc">${esc(el.props.text || '')}</div>` },
  image: { category: 'output', name: 'Иллюстрация', icon: '🖼', defaultSize: { w: 260, h: 180 }, props: { url: '' }, render: (el) => el.props.url ? `<img class="meta-img" src="${esc(el.props.url)}">` : `<div class="meta-img-ph">нет картинки</div>` },
  input_text: { category: 'input', name: 'Поле ввода', icon: '⌨', defaultSize: { w: 320, h: 48 }, props: { placeholder: 'Введите ответ…' }, render: (el, ctx) => `<input class="meta-input" placeholder="${esc(el.props.placeholder || '')}" ${ctx && ctx.play ? '' : 'disabled'}>` },
  compare: { category: 'logic', name: 'Сравнение ответа', icon: '≡', defaultSize: { w: 300, h: 140 }, props: { variants: [{ text: '', points: 0 }] }, render: (el) => `<div class="meta-compare">${(el.props.variants || []).map(x => `<div class="meta-cmp-row"><span>${esc(x.text || '…')}</span><b>+${Number(x.points)||0}</b></div>`).join('') || '<span class="meta-muted">пусто</span>'}</div>` }
};

const M = { project: null, mode: 'edit', selectedBlockId: null, selectedElId: null, drag: null, dirty: false, _svg: null };
const newProject = () => ({ id: null, title: '', description: '', avatar: '', published: false, data: { schemaVersion: 1, startBlockId: null, blocks: [], links: [] } });
const findBlock = (id) => M.project.data.blocks.find(b => b.id === id) || null;
const findElement = (bId, eId) => { const b = findBlock(bId); return b ? (b.elements.find(e => e.id === eId) || null) : null; };
const findCompareForInput = (iId) => { const l = M.project.data.links.find(x => x.kind === 'data' && x.from === iId && x.to && x.to.startsWith('cmp:')); if(!l) return null; const [, bId, cId] = l.to.split(':'); return findElement(bId, cId); };
const isInputConnected = (iId) => !!findCompareForInput(iId);
const snap = v => Math.round(v / GRID) * GRID;
const rectsOverlap = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
const fitsInBlock = (el) => el.x >= 0 && el.y >= 0 && el.x + el.w <= BLOCK_W && el.y + el.h <= BLOCK_H;
const collides = (b, el) => b.elements.some(o => o.id !== el.id && rectsOverlap(el, o));
const normAns = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');

async function uploadMetaImage(file){ if(!file) return ''; const ext = (file.name.split('.').pop() || 'png').toLowerCase(); const name = Date.now() + '-' + uid() + '.' + ext; const { error } = await sb.storage.from(BUCKET).upload(name, file); if(error) throw error; return sb.storage.from(BUCKET).getPublicUrl(name).data.publicUrl; }
async function loadProject(id){ const { data, error } = await sb.from('meta_projects').select('*').eq('id', id).maybeSingle(); if(error) throw error; if(!data) return null; return { id: data.id, title: data.title || '', description: data.description || '', avatar: data.avatar || '', published: !!data.published, data: Object.assign(newProject().data, data.data || {}) }; }
async function listMyProjects(){ if(!window.currentUser) return []; const { data, error } = await sb.from('meta_projects').select('*').eq('author_id', window.currentUser.id).order('updated_at', { ascending: false }); if(error) throw error; return data || []; }
async function listPublishedProjects(){ const { data, error } = await sb.from('meta_projects').select('*, profiles(login)').eq('published', true).order('created_at', { ascending: false }); if(error) throw error; return data || []; }
async function saveProject(publish){
  if(!window.currentUser) throw new Error('Нужно войти в аккаунт');
  const row = { title: M.project.title || 'Без названия', description: M.project.description || '', avatar: M.project.avatar || '', data: M.project.data, published: !!publish, updated_at: new Date().toISOString() };
  if(M.project.id){ const { error } = await sb.from('meta_projects').update(row).eq('id', M.project.id); if(error) throw error; }
  else { row.author_id = window.currentUser.id; const { data, error } = await sb.from('meta_projects').insert(row).select().single(); if(error) throw error; M.project.id = data.id; }
  M.project.published = !!publish; M.dirty = false; return M.project.id;
}

function injectStyles(){
  if($('meta-styles')) return;
  const st = document.createElement('style'); st.id = 'meta-styles';
  st.textContent = `
  #metaPage, #metaListPage, #metaPlayPage {padding:24px;max-width:1400px;margin:0 auto}
  .meta-top{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
  .meta-head{display:flex;gap:20px;background:#fff;color:#1d1d1d;border-radius:16px;padding:20px;margin-bottom:16px}
  .meta-head-fields{flex:1;} .meta-head-preview{width:220px;}
  .meta-card{background:#fff;border:2px solid #eee;border-radius:16px;padding:16px;display:flex;flex-direction:column;align-items:center;text-align:center}
  .meta-card .test-icon{width:100%;height:110px;border-radius:12px;background:#f4e238;display:flex;align-items:center;justify-content:center;font-size:46px;margin-bottom:10px;overflow:hidden}
  .meta-card .test-icon img{width:100%;height:100%;object-fit:cover}
  .meta-card h3{font-size:16px;color:#d0162c;margin-bottom:6px;}
  .meta-canvas-wrap{position:relative;background:#e8e8e8;border-radius:16px;overflow:hidden;height:640px;border:2px solid #ccc}
  .meta-canvas{position:absolute;inset:0;overflow:auto;background:#f7f7f7;background-image:linear-gradient(#e0e0e0 1px,transparent 1px),linear-gradient(90deg,#e0e0e0 1px,transparent 1px);background-size:20px 20px}
  .meta-canvas-inner{position:relative;width:2000px;height:1600px}
  .meta-block{position:absolute;background:#fff;border:3px solid #c0c0c0;border-radius:12px;cursor:pointer}
  .meta-block.start{border-color:#2ea043} .meta-block.end{border-color:#d0162c} .meta-block.sel{border-color:#f4e238;box-shadow:0 0 0 4px rgba(244,226,56,.4)}
  .meta-block .mb-title{position:absolute;top:0;left:0;right:0;padding:4px 8px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;font-weight:700;display:flex;justify-content:space-between;pointer-events:none}
  .meta-block .mb-body{position:absolute;inset:28px 0 0 0;background:#fbfbfb;overflow:hidden}
  .meta-block .mb-body-img{position:absolute;inset:0;background-size:cover;opacity:.35}
  .meta-el{position:absolute;border:2px dashed #9bbad6;background:rgba(255,255,255,.85);border-radius:6px;padding:4px;font-size:13px;cursor:move}
  .meta-el.sel{border-color:#d0162c;box-shadow:0 0 0 2px rgba(208,22,44,.25)} .meta-el.bad{border-color:#d0162c;background:#fff0f0}
  .meta-el .me-id{position:absolute;top:2px;right:4px;font-size:10px;background:#333;color:#fff;padding:0 4px;z-index:3}
  .meta-el .me-id.ok{background:#2ea043} .meta-el .me-body{margin-top:14px;pointer-events:none;word-break:break-word}
  .meta-el .me-dot{position:absolute;right:-9px;top:50%;transform:translateY(-50%);width:14px;height:14px;border-radius:50%;background:#d0162c;border:2px solid #fff;cursor:crosshair;z-index:4}
  .meta-lines{position:absolute;inset:0;pointer-events:none;z-index:1} .meta-lines svg{width:100%;height:100%}
  .meta-link-line{stroke:#888;stroke-width:2;fill:none} .meta-link-line.data{stroke:#d0162c;stroke-dasharray:5 4}
  .meta-toolbar{display:flex;gap:8px;background:#fff;border-radius:14px;padding:10px 14px;margin-top:12px}
  .meta-tb-group{display:flex;gap:6px;background:#f4f4f4;padding:4px 8px;border-radius:10px} .meta-tb-group b{font-size:12px;color:#6b6b6b;}
  .meta-tb-item{display:flex;flex-direction:column;align-items:center;padding:6px 10px;background:#fff;border:2px solid #e2e2e2;cursor:grab;font-size:12px;font-weight:700;min-width:64px}
  .meta-right{width:300px;flex-shrink:0;background:#fff;border-radius:16px;padding:16px}
  .meta-right .field{margin-bottom:10px} .meta-right input,.meta-right textarea,.meta-right select{width:100%;padding:8px;border:2px solid #e2e2e2;border-radius:8px;}
  .meta-editor-layout{display:flex;gap:16px;} .meta-editor-main{flex:1;min-width:0}
  .meta-play{background:#111;position:relative;height:640px;display:none} .meta-play-inner{position:absolute;inset:0;background-size:cover}
  .meta-play .meta-el{border:none;background:transparent;cursor:default} .meta-play .meta-el .me-id,.meta-play .meta-el .me-dot{display:none} .meta-play .meta-el .me-body{margin-top:0;pointer-events:auto}
  .meta-play-result{position:absolute;inset:0;background:rgba(0,0,0,.75);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
  `;
  document.head.appendChild(st);
}

function buildPage(){
  if($('metaPage')) return;
  const d = document.createElement('div'); d.id = 'metaPage'; d.className = 'page';
  d.innerHTML = `
    <div class="meta-top"><button class="btn btn-profile" id="metaBack">← Назад</button><h2 style="color:#f4e238;margin:0;flex:1">Метаредактор</h2>
      <button class="btn btn-profile" id="metaModeEdit">✏️ Ред.</button><button class="btn btn-profile" id="metaModePlay">▶ Плей</button></div>
    <div class="meta-head"><div class="meta-head-fields">
      <div class="field"><label>Название</label><input id="metaTitle"></div>
      <div class="field"><label>Описание</label><textarea id="metaDesc" rows="2"></textarea></div>
      <div class="field"><label>Обложка</label><input type="file" id="metaAvaFile" accept="image/*"></div>
      <div class="meta-top"><button class="btn btn-profile" id="metaSaveDraft">💾 Сохранить</button><button class="btn btn-create" id="metaPublish">🚀 Опубликовать</button></div>
      <div id="metaMsg" style="color:#fff;font-size:14px;margin-top:8px"></div>
    </div><div class="meta-head-preview"><div class="meta-card"><div class="test-icon" id="metaPvIcon">✨</div><h3 id="metaPvTitle">Название</h3><div id="metaPvDesc" style="font-size:13px;color:#6b6b6b">Описание</div></div></div></div>
    <div class="meta-editor-layout"><div class="meta-editor-main">
      <div class="meta-canvas-wrap" id="metaCanvasWrap"><div class="meta-canvas" id="metaCanvas"><div class="meta-canvas-inner" id="metaCanvasInner"></div></div><div class="meta-play" id="metaPlayBox"></div></div>
      <div class="meta-toolbar" id="metaToolbar"></div><div id="metaErrors" style="margin-top:12px;color:#fff"></div>
    </div><div class="meta-right" id="metaRight"></div></div>
  `;
  document.body.appendChild(d);
}

function renderPreviewCard(){
  if(M.project.avatar) $('metaPvIcon').innerHTML = '<img src="' + esc(M.project.avatar) + '">'; else $('metaPvIcon').textContent = '✨';
  $('metaPvTitle').textContent = M.project.title || 'Название'; $('metaPvDesc').textContent = M.project.description || 'Описание';
}

function renderToolbar(){
  const tb = $('metaToolbar'); tb.innerHTML = '';
  const mk = (kind, icon, label, cat, type) => {
    const d = document.createElement('div'); d.className = 'meta-tb-item'; d.dataset.kind = kind; d.dataset.type = type || ''; d.draggable = true;
    d.innerHTML = '<span>' + icon + '</span><span>' + label + '</span>';
    d.ondragstart = e => { e.dataTransfer.setData('text/plain', '1'); M.drag = { kind, type }; };
    return d;
  };
  const g1 = document.createElement('div'); g1.className = 'meta-tb-group'; g1.innerHTML = '<b>Блоки</b>'; g1.appendChild(mk('block', '▭', 'Блок')); g1.appendChild(mk('block', '🏁', 'Конец', 'end')); tb.appendChild(g1);
  const g2 = document.createElement('div'); g2.className = 'meta-tb-group'; g2.innerHTML = '<b>Элементы</b>';
  ['text','desc','image','input_text','compare'].forEach(t => g2.appendChild(mk('el', ELEMENT_TYPES[t].icon, ELEMENT_TYPES[t].name, t)));
  tb.appendChild(g2);
}

function renderCanvas(){
  const inner = $('metaCanvasInner'); inner.innerHTML = '';
  const svgWrap = document.createElement('div'); svgWrap.className = 'meta-lines';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 2000 1600'); svgWrap.appendChild(svg); inner.appendChild(svgWrap); M._svg = svg;
  M.project.data.blocks.forEach(b => {
    const d = document.createElement('div'); d.className = 'meta-block' + (M.selectedBlockId === b.id ? ' sel' : '') + (M.project.data.startBlockId === b.id ? ' start' : '') + (b.end ? ' end' : '');
    d.style.cssText = `left:${b.x}px;top:${b.y}px;width:${BLOCK_W}px;height:${BLOCK_H}px`;
    d.innerHTML = `<div class="mb-title"><span>${b.end?'Конец':'Блок'} ${esc(b.title||'')}</span><span>${esc(b.id.slice(0,4))}</span></div><div class="mb-body" id="mbb-${b.id}">${b.bg?'<div class="mb-body-img" style="background-image:url('+esc(b.bg)+')"></div>':''}</div>`;
    const body = d.querySelector('.mb-body');
    b.elements.forEach(el => {
      const ed = document.createElement('div'); ed.className = 'meta-el' + (M.selectedElId === el.id ? ' sel' : '') + (el.type === 'input_text' && !isInputConnected(el.id) ? ' bad' : '');
      ed.style.cssText = `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;
      const con = el.type === 'input_text' && isInputConnected(el.id);
      ed.innerHTML = `<span class="me-id ${con?'ok':''}">${esc(el.id.slice(0,4))}</span>${el.type==='input_text'?'<span class="me-dot"></span>':''}<div class="me-body">${ELEMENT_TYPES[el.type].render(el)}</div>`;
      ed.querySelector('.me-id').onclick = e => { e.stopPropagation(); navigator.clipboard.writeText(el.id); };
      ed.onmousedown = e => { if(e.target.closest('.me-id')||e.target.closest('.me-dot')) return; e.preventDefault(); M.selectedBlockId=b.id; M.selectedElId=el.id; renderCanvas(); renderRightPanel(); };
      const dot = ed.querySelector('.me-dot'); if(dot) dot.onmousedown = e => startLink(e, el.id);
      body.appendChild(ed);
    });
    d.querySelector('.mb-title').onmousedown = e => { e.preventDefault(); M.selectedBlockId=b.id; M.selectedElId=null; renderCanvas(); renderRightPanel(); const sx=e.clientX,sy=e.clientY,bx=b.x,by=b.y; const mv=ev=>{b.x=snap(bx+ev.clientX-sx); b.y=snap(by+ev.clientY-sy); d.style.left=b.x+'px'; d.style.top=b.y+'px'; drawLinks();}; const up=()=>{window.removeEventListener('pointermove',mv);window.removeEventListener('pointerup',up);}; window.addEventListener('pointermove',mv); window.addEventListener('pointerup',up); };
    body.ondragover = e => { if(M.drag && M.drag.kind === 'el') e.preventDefault(); };
    body.ondrop = e => { if(!M.drag || M.drag.kind !== 'el') return; e.preventDefault(); const r=body.getBoundingClientRect(); addEl(b.id, M.drag.type, e.clientX-r.left, e.clientY-r.top); };
    inner.appendChild(d);
  });
  inner.ondragover = e => { if(M.drag && M.drag.kind === 'block') e.preventDefault(); };
  inner.ondrop = e => { if(!M.drag || M.drag.kind !== 'block') return; e.preventDefault(); const r=inner.getBoundingClientRect(); addBlock(M.drag.type==='end', e.clientX-r.left, e.clientY-r.top); };
  drawLinks();
}

function drawLinks(){
  const svg = M._svg; while(svg.firstChild) svg.removeChild(svg.firstChild);
  const defs = document.createElementNS('http://www.w3.org/2000/svg','defs'); defs.innerHTML = '<marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><polygon points="0,0 10,5 0,10" fill="#888"/></marker>'; svg.appendChild(defs);
  M.project.data.links.filter(l => l.kind === 'transition').forEach(l => {
    const fb = findBlock(l.from), tb = findBlock(l.to); if(!fb||!tb) return;
    const p = document.createElementNS('http://www.w3.org/2000/svg','path'); p.setAttribute('d', `M${fb.x+BLOCK_W},${fb.y+BLOCK_H/2} C${(fb.x+BLOCK_W+tb.x)/2},${fb.y+BLOCK_H/2} ${(fb.x+BLOCK_W+tb.x)/2},${tb.y+BLOCK_H/2} ${tb.x},${tb.y+BLOCK_H/2}`); p.setAttribute('stroke','#888'); p.setAttribute('fill','none'); p.setAttribute('marker-end','url(#arr)'); svg.appendChild(p);
  });
}

function startLink(e, iId){
  e.preventDefault(); const svg = M._svg; const p = document.createElementNS('http://www.w3.org/2000/svg','path'); p.setAttribute('stroke','#d0162c'); p.setAttribute('fill','none'); svg.appendChild(p);
  const mv = ev => { const r = $('metaCanvasInner').getBoundingClientRect(); p.setAttribute('d', `M${e.clientX-r.left},${e.clientY-r.top} L${ev.clientX-r.left},${ev.clientY-r.top}`); };
  const up = ev => { window.removeEventListener('pointermove',mv); window.removeEventListener('pointerup',up); p.remove();
    const els = document.elementsFromPoint(ev.clientX, ev.clientY);
    const cmpNode = els.find(x => x.classList.contains('meta-el') && x.querySelector('.meta-compare'));
    if(cmpNode){ const cId = cmpNode.querySelector('.me-id').textContent; 
      const cmpEl = M.project.data.blocks.flatMap(b=>b.elements).find(x=>x.id.startsWith(cId)&&x.type==='compare'); 
      if(cmpEl){ M.project.data.links = M.project.data.links.filter(l=>!(l.kind==='data'&&l.from===iId)); M.project.data.links.push({id:uid(),kind:'data',from:iId,to:'cmp:x:'+cmpEl.id}); renderCanvas(); renderRightPanel(); } } };
  window.addEventListener('pointermove',mv); window.addEventListener('pointerup',up);
}

function addBlock(isEnd, x, y){
  const b = { id: uid(), x: Math.max(0,snap(x)), y: Math.max(0,snap(y)), title: '', bg: '', end: !!isEnd, elements: [] };
  M.project.data.blocks.push(b); if(!M.project.data.startBlockId) M.project.data.startBlockId = b.id;
  M.selectedBlockId = b.id; M.selectedElId = null; M.dirty = true; renderCanvas(); renderRightPanel();
}
function addEl(bId, type, px, py){
  const b = findBlock(bId); const def = ELEMENT_TYPES[type]; const sz = def.defaultSize;
  const el = { id: uid(), type, x: Math.max(0, snap(px - sz.w/2)), y: Math.max(0, snap(py - sz.h/2)), w: sz.w, h: sz.h, props: JSON.parse(JSON.stringify(def.props)) };
  b.elements.push(el); M.selectedBlockId = bId; M.selectedElId = el.id; M.dirty = true; renderCanvas(); renderRightPanel();
}

function renderRightPanel(){
  const box = $('metaRight'); box.innerHTML = '';
  if(M.selectedElId){
    const b = M.project.data.blocks.find(x => x.elements.some(e => e.id === M.selectedElId));
    const el = b.elements.find(e => e.id === M.selectedElId);
    box.innerHTML = `<h3 style="color:#d0162c">${ELEMENT_TYPES[el.type].name}</h3><div class="field"><label>Содержимое / URL</label><textarea id="p-prop" rows="3">${esc(el.props.text||el.props.url||el.props.placeholder||'')}</textarea></div>`;
    if(el.type==='compare') box.innerHTML += `<div class="field"><label>Очки за верный ответ</label><input type="number" id="p-pts" value="${el.props.variants[0].points||0}"></div>`;
    box.innerHTML += `<button class="btn btn-danger" id="p-del" style="width:100%;margin-top:10px;background:#d0162c;color:#fff">Удалить</button>`;
    if($('p-prop')) $('p-prop').oninput = e => { if(el.props.text!==undefined) el.props.text=e.target.value; else if(el.props.url!==undefined) el.props.url=e.target.value; else el.props.placeholder=e.target.value; M.dirty=true; renderCanvas(); };
    if($('p-pts')) $('p-pts').oninput = e => { el.props.variants[0].points=Number(e.target.value); el.props.variants[0].text = 'правильно'; M.dirty=true; renderCanvas(); };
    $('p-del').onclick = () => { b.elements = b.elements.filter(x => x.id !== el.id); M.project.data.links = M.project.data.links.filter(l=>l.from!==el.id); M.selectedElId=null; M.dirty=true; renderCanvas(); renderRightPanel(); };
    return;
  }
  if(M.selectedBlockId){
    const b = findBlock(M.selectedBlockId);
    box.innerHTML = `<h3 style="color:#d0162c">${b.end?'Конец':'Блок'}</h3><div class="field"><label>Название</label><input id="p-bt" value="${esc(b.title||'')}"></div>
    <div class="field"><label>Переход к блоку</label><select id="p-link"><option value="">— нет —</option>${M.project.data.blocks.filter(x=>x.id!==b.id).map(x=>`<option value="${x.id}" ${M.project.data.links.some(l=>l.from===b.id&&l.to===x.id)?'selected':''}>${esc(x.title||x.id.slice(0,4))}</option>`).join('')}</select></div>
    <div class="field"><label>Условие (очки)</label><div style="display:flex;gap:4px"><select id="p-op" style="width:50px"><option value="">—</option><option value=">">></option><option value="<"><</option><option value="=">=</option></select><input type="number" id="p-val" value="0" style="width:60px"></div></div>
    <button class="btn btn-danger" id="p-bdel" style="width:100%;margin-top:10px;background:#d0162c;color:#fff">Удалить блок</button>`;
    $('p-bt').oninput = e => { b.title=e.target.value; M.dirty=true; renderCanvas(); };
    $('p-link').onchange = e => { M.project.data.links = M.project.data.links.filter(l=>l.from!==b.id); if(e.target.value) M.project.data.links.push({id:uid(),kind:'transition',from:b.id,to:e.target.value,condition:null}); M.dirty=true; renderCanvas(); };
    $('p-bdel').onclick = () => { M.project.data.blocks = M.project.data.blocks.filter(x=>x.id!==b.id); M.project.data.links = M.project.data.links.filter(l=>l.from!==b.id&&l.to!==b.id); M.selectedBlockId=null; M.dirty=true; renderCanvas(); renderRightPanel(); };
    return;
  }
  box.innerHTML = '<div style="color:#999;font-size:13px">Выбери блок или элемент</div>';
}

function loadToUI(){
  $('metaTitle').value = M.project.title || ''; $('metaDesc').value = M.project.description || '';
  renderPreviewCard();
}
function bindHeader(){
  $('metaTitle').oninput = e => { M.project.title = e.target.value; renderPreviewCard(); };
  $('metaDesc').oninput = e => { M.project.description = e.target.value; renderPreviewCard(); };
  $('metaAvaFile').onchange = async e => { const f=e.target.files[0]; if(f){ M.project.avatar = await uploadMetaImage(f); renderPreviewCard(); } };
  $('metaSaveDraft').onclick = async () => { $('metaMsg').textContent='Сохраняем...'; await saveProject(M.project.published); $('metaMsg').textContent='Сохранено!'; };
  $('metaPublish').onclick = async () => { $('metaMsg').textContent='Публикуем...'; await saveProject(true); $('metaMsg').textContent='Опубликовано!'; };
  $('metaBack').onclick = () => location.hash = '#/meta';
  $('metaModeEdit').onclick = () => { $('metaCanvas').style.display='block'; $('metaPlayBox').style.display='none'; $('metaModeEdit').style.background='#f4e238'; $('metaModePlay').style.background=''; renderCanvas(); };
  $('metaModePlay').onclick = () => { $('metaCanvas').style.display='none'; $('metaPlayBox').style.display='block'; $('metaModeEdit').style.background=''; $('metaModePlay').style.background='#f4e238'; startPlay(); };
}

function openProjectPage(id){
  injectStyles(); buildPage();
  if(!window.currentUser){ alert('Войдите в аккаунт!'); location.hash=''; return; }
  if(id){ loadProject(id).then(p=>{ M.project = p||newProject(); window.showPage('metaPage'); loadToUI(); renderToolbar(); renderCanvas(); renderRightPanel(); bindHeader(); $('metaModeEdit').click(); }); }
  else { M.project = newProject(); window.showPage('metaPage'); loadToUI(); renderToolbar(); renderCanvas(); renderRightPanel(); bindHeader(); $('metaModeEdit').click(); }
}
function openProjectsPage(){
  injectStyles();
  if(!$('metaListPage')){ const d=document.createElement('div'); d.id='metaListPage'; d.className='page'; d.innerHTML='<h2 style="color:#f4e238">Мои проекты</h2><button class="btn btn-create" id="mNew" style="margin:10px 0">+ Создать</button><div class="grid" id="mGrid"></div>'; document.body.appendChild(d); $('mNew').onclick=()=>location.hash='#/meta/new'; }
  window.showPage('metaListPage'); const g = $('mGrid'); g.innerHTML='Загрузка...';
  listMyProjects().then(list => { g.innerHTML = list.length ? '' : 'Пусто'; list.forEach(p => { const c=document.createElement('div'); c.className='meta-card'; c.innerHTML=`<div class="test-icon">${p.avatar?'<img src="'+esc(p.avatar)+'">':'✨'}</div><h3>${esc(p.title)}</h3><button class="btn btn-create" style="margin-top:10px">Открыть</button>`; c.onclick=()=>location.hash='#/meta/edit/'+p.id; g.appendChild(c); }); });
}

let P = { project: null, blockId: null, score: 0, answers: {}, container: null };
function startPlay(){
  P.project = JSON.parse(JSON.stringify(M.project)); P.blockId = M.project.data.startBlockId; P.score = 0; P.answers = {}; P.container = $('metaPlayBox'); renderPlay();
}
function renderPlay(){
  const box = P.container; box.innerHTML = '';
  const b = P.project.data.blocks.find(x => x.id === P.blockId); if(!b) return;
  const inner = document.createElement('div'); inner.className='meta-play-inner'; if(b.bg) inner.style.backgroundImage='url('+b.bg+')';
  const stage = document.createElement('div'); stage.style.cssText='position:absolute;inset:0;';
  b.elements.forEach(el => {
    const ed = document.createElement('div'); ed.className='meta-el'; ed.style.cssText=`left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;
    ed.innerHTML = `<div class="me-body">${ELEMENT_TYPES[el.type].render(el, {play:true})}</div>`;
    if(el.type==='input_text'){ const inp = ed.querySelector('input'); inp.value = P.answers[el.id]||''; inp.oninput = () => P.answers[el.id]=inp.value; }
    stage.appendChild(ed);
  });
  inner.appendChild(stage);
  const btn = document.createElement('button'); btn.className='btn btn-create'; btn.textContent='Далее'; btn.style.cssText='position:absolute;right:20px;bottom:20px;z-index:10;font-size:18px';
  btn.onclick = () => nextPlay(b);
  box.appendChild(inner); box.appendChild(btn);
}
function nextPlay(b){
  b.elements.forEach(el => { if(el.type==='input_text'){ const cmp = findCompareForInput(el.id); if(cmp){ const val=normAns(P.answers[el.id]); cmp.props.variants.forEach(v=>{ if(normAns(v.text)===val) P.score+=Number(v.points)||0; }); } } });
  const link = P.project.data.links.find(l => l.kind==='transition' && l.from===b.id);
  if(!link){ box.innerHTML = '<div class="meta-play-result"><h2>Конец</h2><p>Очки: '+P.score+'</p></div>'; return; }
  P.blockId = link.to; renderPlay();
}

async function openPlayPage(id){
  injectStyles();
  if(!$('metaPlayPage')){ const d=document.createElement('div'); d.id='metaPlayPage'; d.className='page'; d.innerHTML='<div style="max-width:1000px;margin:0 auto;padding:20px"><h2 id="mPTitle" style="color:#f4e238;text-align:center"></h2><div id="mPArea" style="position:relative;height:640px;background:#111;border-radius:16px;overflow:hidden"></div></div>'; document.body.appendChild(d); }
  window.showPage('metaPlayPage'); $('mPArea').innerHTML = 'Загрузка...';
  loadProject(id).then(p => { if(!p) return; $('mPTitle').textContent = p.title; P = { project: p, blockId: p.data.startBlockId, score: 0, answers: {}, container: $('mPArea') }; renderPlay(); });
}

window.metaRoute = function(h){
  if(!h.startsWith('#/meta')) return false;
  if(h === '#/meta' || h === '#/meta/'){ openProjectsPage(); return true; }
  if(h === '#/meta/new'){ openProjectPage(null); return true; }
  if(h.startsWith('#/meta/edit/')){ openProjectPage(h.slice(11)); return true; }
  if(h.startsWith('#/meta/play/')){ openPlayPage(h.slice(11)); return true; }
  openProjectsPage(); return true;
};

(function(){
  let busy = false;
  const tryInject = async () => {
    if(busy) return; const grid = $('testGrid'); if(!grid) return;
    if(location.hash && location.hash !== '#/' && location.hash !== '') return;
    if(!grid.querySelectorAll('.card').length) return;
    if(grid.querySelector('.meta-card-home')) return;
    busy = true;
    try {
      const list = await listPublishedProjects();
      if(!list.length){ busy = false; return; }
      list.forEach(p => {
        const card = document.createElement('div'); card.className = 'card meta-card-home';
        card.innerHTML = '<div class="test-icon">'+(p.avatar?'<img src="'+esc(p.avatar)+'">':'✨')+'</div><h3>'+esc(p.title)+'</h3><div class="author">от '+(p.profiles?esc(p.profiles.login):'???')+'</div>';
        card.onclick = () => { location.hash = '#/meta/play/' + p.id; };
        grid.appendChild(card);
      });
    } catch(_){}
    busy = false;
  };
  window.addEventListener('hashchange', () => { setTimeout(tryInject, 450); });
  setTimeout(tryInject, 800);
})();

(function(){
  const addBtn = () => { const nav = document.getElementById('navBox'); if(!nav||nav.querySelector('.meta-nav-btn')) return; const btn=document.createElement('a'); btn.href='#/meta'; btn.className='btn btn-nav meta-nav-btn'; btn.textContent='Метаредактор'; nav.insertBefore(btn, nav.firstChild); };
  const tryOverride = () => { if(window.renderNav && !window.renderNav._w){ const o=window.renderNav; window.renderNav=function(){o.apply(this,arguments); addBtn();}; window.renderNav._w=true; } };
  if(typeof renderNav === 'function') tryOverride();
  setInterval(() => { tryOverride(); if(document.getElementById('navBox')) { addBtn(); } }, 500);
})();

})();
