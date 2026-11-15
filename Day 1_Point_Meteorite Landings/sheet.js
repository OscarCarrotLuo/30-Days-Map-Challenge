(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const map = $('map');
  const earth = $('world');
  const terrain = $('terrain');
  const linework = $('linework');
  const base = terrain.getContext('2d', { alpha: false });
  const ink = linework.getContext('2d');
  const rad = Math.PI / 180;
  const earthRadius = 6371.0088;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const wrap = value => value - Math.floor(value);
  const latitudeY = lat => (90 - lat) / 180;
  const latitudeAt = y => 90 - 180*y;
  const longitudeAt = x => wrap(x)*360 - 180;
  // Zoom is measured in frame widths. The 2:1 world fills the square at two widths.
  const fitHeightZoom = 2;
  const limitZoom = z => clamp(z, fitHeightZoom, 48);
  const layer = { fall: true, find: true };
  const sites = window.METEORITES.map(([name, lat, lon, fell, year, type, grams, id]) => ({
    name, lat, lon, kind: fell ? 'fall' : 'find', year, type, grams, id,
    x: (lon+180)/360, y: latitudeY(lat)
  }));
  const byId = new Map(sites.map(s => [s.id, s]));
  const byName = new Map(sites.map(s => [s.name, s]));
  // Coincident records share a printed point within each class. All entries remain in the index.
  const marks = {};
  for (const kind of ['find', 'fall']) {
    const records = sites.filter(s => s.kind === kind);
    $(kind+'-count').textContent = records.length.toLocaleString('en-US');
    const unique = new Map();
    for (const site of records) {
      const key = site.lat + ',' + site.lon;
      if (!unique.has(key)) unique.set(key, site);
    }
    marks[kind] = [...unique.values()];
  }
  const signatureSites = ['Allende', 'Chelyabinsk', 'Hoba', 'Murchison', 'Allan Hills 84001',
    'Campo del Cielo', 'Tagish Lake', 'Tissint', 'Yamato 000593', 'Sikhote-Alin'].map(name => byName.get(name));
  const home = { x: .5, y: .5, zoom: fitHeightZoom };
  let view = { ...home };
  let W = 0, H = 0, dpr = 1, letterSize = 10, chartFont = '';
  let queued = false, flight = null, selected = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let labelHits = [];

  function coordinate(value, isLat, digits = 0) {
    const n = Math.abs(value);
    const suffix = Number(n.toFixed(digits)) === 0 || (!isLat && Number(n.toFixed(digits)) === 180)
      ? '' : isLat ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
    return n.toFixed(digits)+'°'+suffix;
  }
  function normalize() {
    view.zoom = limitZoom(view.zoom);
    const half = Math.min(.5, H / (W * view.zoom));
    view.y = clamp(view.y, half, 1-half);
    view.x = wrap(view.x);
  }
  function geometry() {
    // The square viewport and the plate carrée raster have independent aspect ratios.
    const worldWidth = W * view.zoom;
    const worldHeight = worldWidth / 2;
    const top = view.y - H / (2 * worldHeight);
    const bottom = top + H / worldHeight;
    return { worldWidth, worldHeight, top, left: view.x-.5/view.zoom,
      northY: Math.max(0, top), southY: Math.min(1, bottom),
      kmX: 2*Math.PI*earthRadius*Math.cos(latitudeAt(view.y)*rad)/worldWidth };
  }
  function visibleX(x, g) {
    return (x + Math.round(view.x-x)-g.left)*g.worldWidth;
  }
  function invalidate() {
    if (!queued) { queued = true; requestAnimationFrame(render); }
  }
  function sizeCanvas(canvas, w, h) {
    const pw = Math.round(w*dpr), ph = Math.round(h*dpr);
    if (canvas.width !== pw || canvas.height !== ph) {canvas.width = pw; canvas.height = ph;}
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  function paintBase(g) {
    base.fillStyle = '#fff';
    base.fillRect(0, 0, W, H);
    if (!earth.naturalWidth) return;
    const ymin = g.northY, ymax = g.southY;
    // Crop the source rectangle first, including across the antimeridian.
    for (let copy = Math.floor(g.left); copy <= Math.floor(g.left+1/view.zoom); copy++) {
      const left = Math.max(g.left, copy), right = Math.min(g.left+1/view.zoom, copy+1);
      if (right-left < 1e-9) continue;
      base.drawImage(earth, (left-copy)*earth.width, ymin*earth.height,
        (right-left)*earth.width, (ymax-ymin)*earth.height,
        (left-g.left)*g.worldWidth, (ymin-g.top)*g.worldHeight, (right-left)*g.worldWidth, (ymax-ymin)*g.worldHeight);
    }
  }

  const degreeSteps = [.25, .5, 1, 2, 5, 10, 15, 20, 30, 45, 60, 90];
  function tickStep(target) {
    return degreeSteps.reduce((a,b) => Math.abs(Math.log(a/target)) < Math.abs(Math.log(b/target)) ? a : b);
  }
  function gridAxis(isLat, g) {
    const axis = $(isLat ? 'latitude' : 'longitude');
    const w = axis.clientWidth, h = axis.clientHeight;
    const ctx = sizeCanvas(axis, w, h);
    ctx.clearRect(0,0,w,h);
    ctx.font = chartFont; ctx.textAlign = 'center'; ctx.fillStyle = '#383835';
    ctx.strokeStyle = '#696964'; ctx.lineWidth = .6;
    const lower = isLat ? latitudeAt(g.southY) : g.left*360-180;
    const upper = isLat ? latitudeAt(g.northY) : (g.left+1/view.zoom)*360-180;
    const targetPx = clamp(W*.123, 52, 115);
    const axisLength = isLat ? H : W;
    const pixelsPerDegree = isLat ? g.worldHeight/180 : g.worldWidth/360;
    const step = tickStep(targetPx/pixelsPerDegree);
    const sub = step/5;
    ink.beginPath(); ctx.beginPath();
    for (let n=Math.ceil((lower-1e-7)/sub); n <= Math.floor((upper+1e-7)/sub); n++) {
      const v = n*sub;
      const p = isLat ? (latitudeY(v)-g.top)*g.worldHeight : ((v+180)/360-g.left)*g.worldWidth;
      const major = n%5 === 0;
      if (major) {
        if (isLat) { ink.moveTo(0,p); ink.lineTo(W,p); }
        else { ink.moveTo(p,0); ink.lineTo(p,H); }
      }
      const tick = major ? 4.2 : 2;
      if (isLat) { ctx.moveTo(w-tick,p); ctx.lineTo(w,p); }
      else { ctx.moveTo(p,0); ctx.lineTo(p,tick); }
      if (!major || p < 2*letterSize || p > axisLength-2*letterSize) continue;
      const value = isLat ? v : longitudeAt((v+180)/360);
      const label = coordinate(value,isLat,step < 1 ? (step === .25 ? 2 : 1) : 0);
      ctx.save();
      if (isLat) { ctx.translate(w-6,p); ctx.rotate(-Math.PI/2); ctx.textBaseline='bottom'; }
      else { ctx.translate(p,5); ctx.textBaseline='top'; }
      ctx.fillText(label,0,0); ctx.restore();
    }
    ink.lineWidth=.55; ink.strokeStyle='rgba(255,255,255,.46)'; ink.stroke(); ctx.stroke();
  }

  function drawPoints(g, kind) {
    if (!layer[kind]) return;
    const size = clamp(W/850, .71, 1.1);
    const r = (kind === 'fall' ? 1.95 : 1.05)*size + .28*Math.log2(view.zoom);
    ink.beginPath();
    for (const s of marks[kind]) {
      const y = (s.y-g.top)*g.worldHeight;
      if (y < -r || y > H+r) continue;
      const x = visibleX(s.x, g);
      if (x < -r || x > W+r) continue;
      ink.moveTo(x+r,y); ink.arc(x,y,r,0,2*Math.PI);
    }
    if (kind === 'fall') {
      ink.fillStyle = '#a03c32'; ink.strokeStyle = '#fff4ed';
      ink.lineWidth = .67*size; ink.fill(); ink.stroke();
    } else {
      ink.strokeStyle = 'rgba(33,32,30,.85)'; ink.lineWidth = 1.45*size; ink.stroke();
      ink.strokeStyle = '#faf9f5'; ink.lineWidth = .78*size; ink.stroke();
    }
  }
  function siteDetail(s) {
    const mass = s.grams === null ? '' : s.grams >= 1000
      ? (s.grams/1000).toLocaleString('en-US', {maximumSignificantDigits:4})+' kg'
      : s.grams.toLocaleString('en-US', {maximumSignificantDigits:4})+' g';
    return [s.kind === 'fall' ? 'Observed fall' : 'Find', s.year, s.type, mass].filter(Boolean).join(' · ');
  }
  function drawLabels(g) {
    labelHits = [];
    ink.font = chartFont;
    const named = selected ? [selected, ...signatureSites.filter(s=>s !== selected)] : signatureSites;
    for (const s of named) {
      if (!s || !layer[s.kind] || labelHits.length >= (W < 430 ? 4 : 7)) continue;
      const x = visibleX(s.x,g), y = (s.y-g.top)*g.worldHeight;
      if (x < 4 || x > W-4 || y < 8 || y > H-8) continue;
      const isSelected = s === selected;
      const lines = isSelected ? [s.name, siteDetail(s)] : [s.name];
      const width = Math.max(...lines.map(t=>ink.measureText(t).width));
      const stem = clamp(W*.019,9,20);
      const dir = x + stem + width + 8 > W ? -1 : 1;
      const left = dir===1 ? x+stem+3 : x-stem-width-3;
      const drop = y < letterSize*2+8 ? 1 : -1;
      const by = y + drop*stem*.65;
      const top = by - (lines.length === 2 ? letterSize*.95 : letterSize*.62);
      const box = {s, left:left-3, right:left+width+3, top:top-2, bottom:top+letterSize*1.35*lines.length};
      if (box.left < 0 || box.right > W || box.top < 0 || box.bottom > H) continue;
      if (labelHits.some(b=>box.left < b.right+6 && box.right+6 > b.left && box.top < b.bottom+4 && box.bottom+4 > b.top)) continue;
      ink.beginPath(); ink.moveTo(x,y); ink.lineTo(x+dir*stem*.52,by); ink.lineTo(x+dir*stem,by);
      ink.strokeStyle='rgba(26,25,24,.82)'; ink.lineWidth=1.8; ink.stroke();
      ink.strokeStyle='#fff'; ink.lineWidth=.8; ink.stroke();
      ink.textBaseline='top'; ink.textAlign='left'; ink.lineJoin='round';
      lines.forEach((t,i) => {
        ink.lineWidth=2.4; ink.strokeStyle='rgba(35,34,32,.78)'; ink.strokeText(t,left,top+i*letterSize*1.35);
        ink.fillStyle='#fff'; ink.fillText(t,left,top+i*letterSize*1.35);
      });
      if (isSelected) {
        ink.beginPath(); ink.arc(x,y,5.5,0,2*Math.PI);
        ink.lineWidth=2.5; ink.strokeStyle='#fff'; ink.stroke();
        ink.lineWidth=1.1; ink.strokeStyle='#983b35'; ink.stroke();
      }
      labelHits.push(box);
    }
  }
  function drawScale(g) {
    const canvas = $('scale'), width = canvas.clientWidth, height = canvas.clientHeight;
    const ctx = sizeCanvas(canvas, width, height);
    ctx.clearRect(0, 0, width, height);
    // One subdivided unit left of zero, with full units to the right.
    const available = width - 4 * letterSize;
    if (available <= 0) return;
    const maxStep = available * g.kmX / 5;
    const power = 10 ** Math.floor(Math.log10(maxStep));
    const step = [1, 2, 2.5, 5, 10].filter(v => v * power <= maxStep).pop() * power;
    const stepPx = step / g.kmX;
    const divisions = Math.min(6, Math.floor(available / stepPx + 1e-8) - 1);
    const length = (divisions + 1) * stepPx, start = (width - length) / 2;
    const zero = start + stepPx, baseline = height - 4;
    ctx.strokeStyle = '#242423'; ctx.fillStyle = '#242423'; ctx.lineWidth = .65;
    ctx.strokeRect(start, baseline - 1.5, length, 1.5);
    for (let j = 0; j < 5; j += 2) ctx.fillRect(start + stepPx * j / 5, baseline - 1.5, stepPx / 5, 1.5);
    for (let j = 0; j < divisions; j += 2) ctx.fillRect(zero + stepPx * j, baseline - 1.5, stepPx, 1.5);
    ctx.font = chartFont; ctx.textBaseline = 'bottom'; ctx.textAlign = 'center';
    ctx.beginPath();
    for (let j = -1; j <= divisions; j++) {
      const x = zero + stepPx * j;
      ctx.moveTo(x,baseline + .6); ctx.lineTo(x,baseline - 4);
      ctx.fillText(String(Number((Math.abs(j) * step).toPrecision(5))), x, baseline - 4);
    }
    ctx.stroke();
    canvas.setAttribute('aria-label','Graphic scale, '+step+' kilometres per major division, '+(divisions * step)+' kilometres to the right of zero');
  }
  const locators = [...document.querySelectorAll('.hemisphere')];
  function locatorPoint(lon, lat, meridian, r) {
    return [r+r*Math.cos(lat*rad)*Math.sin((lon-meridian)*rad), r-r*Math.sin(lat*rad)];
  }
  function drawLocators(g) {
    const north = latitudeAt(g.northY), south = latitudeAt(g.southY);
    const west = g.left*360-180, east = west+360/view.zoom;
    for (const button of locators) {
      const meridian = +button.dataset.meridian, c = button.querySelector('canvas');
      const d = c.clientWidth, r = d/2, ctx = sizeCanvas(c,d,d);
      ctx.clearRect(0,0,d,d);
      const edge = (x1,y1,x2,y2,start=false) => {
        const steps = Math.max(1,Math.ceil(Math.max(Math.abs(x1-x2),Math.abs(y1-y2))/4));
        for (let i=0; i<=steps; i++) {
          const t=i/steps, p=locatorPoint(x1+(x2-x1)*t,y1+(y2-y1)*t,meridian,r);
          if (i===0 && start) ctx.moveTo(...p); else ctx.lineTo(...p);
        }
      };
      ctx.beginPath();
      for (const l of [-45,0,45]) edge(meridian+l,-90,meridian+l,90,true);
      for (const b of [-45,0,45]) edge(meridian-90,b,meridian+90,b,true);
      ctx.lineWidth=.45; ctx.strokeStyle='rgba(255,255,255,.65)'; ctx.stroke();
      for (let t=-1; t<=1; t++) {
        const a=Math.max(west,meridian-90+t*360), b=Math.min(east,meridian+90+t*360);
        if (a>=b) continue;
        ctx.beginPath(); edge(a,north,b,north,true); edge(b,north,b,south);
        edge(b,south,a,south); edge(a,south,a,north); ctx.closePath();
        ctx.fillStyle='rgba(166,53,40,.18)'; ctx.fill();
        ctx.lineWidth=2.1; ctx.strokeStyle='#fff7ec'; ctx.stroke();
        ctx.lineWidth=1; ctx.strokeStyle='#a03c32'; ctx.stroke();
      }
    }
  }

  function render(now) {
    queued=false;
    if (flight) {
      const {from,to,start,dx} = flight;
      const t = clamp((now-start)/500,0,1), u = t*t*(3-2*t);
      view={x:from.x+dx*u, y:from.y+(to.y-from.y)*u, zoom:from.zoom*(to.zoom/from.zoom)**u};
      if (t===1) flight=null;
    }
    normalize();
    const g=geometry();
    paintBase(g);
    ink.clearRect(0,0,W,H);
    ink.save();
    ink.beginPath();
    ink.rect(0, (g.northY-g.top)*g.worldHeight, W, (g.southY-g.northY)*g.worldHeight);
    ink.clip();
    gridAxis(false,g); gridAxis(true,g);
    drawPoints(g,'find'); drawPoints(g,'fall'); drawLabels(g);
    ink.restore();
    drawScale(g); drawLocators(g);
    $('position').textContent=coordinate(latitudeAt(view.y),true,2)+'  /  '+coordinate(longitudeAt(view.x),false,2);
    if (flight) invalidate();
  }
  function flyTo(to) {
    flight=null;
    if (reduced.matches) view={...to};
    else flight={from:{...view},to,start:performance.now(),dx:wrap(to.x-view.x+.5)-.5};
    invalidate();
  }
  function setSelection(site) {
    selected=site;
    const current=$('rows').querySelector('[aria-current]');
    if (current) current.removeAttribute('aria-current');
    if (site) $('rows').querySelector('[data-id="'+site.id+'"]')?.setAttribute('aria-current','true');
    $('selection').textContent=site ? site.name+', '+siteDetail(site)+', '+coordinate(site.lat,true,2)+', '+coordinate(site.lon,false,2) : '';
  }
  function goToSite(site) {
    if (!site) return;
    if (!layer[site.kind]) setLayer(site.kind,true);
    setSelection(site);
    flyTo({x:site.x,y:site.y,zoom:Math.max(5.5,view.zoom)});
  }

  const scroll = document.querySelector('.register-scroll');
  let matches = sites, nextRow = 0;
  function addRows() {
    const fragment = document.createDocumentFragment();
    const end = Math.min(nextRow+100,matches.length);
    for (;nextRow<end;nextRow++) {
      const s=matches[nextRow], tr=document.createElement('tr');
      tr.dataset.id=s.id;
      if (selected===s) tr.setAttribute('aria-current','true');
      const first=tr.insertCell(), button=document.createElement('button');
      button.type='button'; button.textContent=s.name;
      button.setAttribute('aria-label','Locate '+s.name); first.append(button);
      tr.insertCell().textContent=coordinate(s.lat,true,2);
      tr.insertCell().textContent=coordinate(s.lon,false,2);
      fragment.append(tr);
    }
    $('rows').append(fragment);
  }
  function refreshIndex() {
    const q=$('query').value.trim().toLowerCase();
    matches=q ? sites.filter(s=>s.name.toLowerCase().includes(q)) : sites;
    nextRow=0; scroll.scrollTop=0; $('rows').replaceChildren(); addRows();
    if (!matches.length) {
      const cell=$('rows').insertRow().insertCell(); cell.colSpan=3; cell.textContent='No matching meteorites';
    }
  }
  $('rows').addEventListener('click',e=>{
    const row=e.target.closest('tr[data-id]');
    if (row) goToSite(byId.get(+row.dataset.id));
  });
  scroll.addEventListener('scroll',()=>{
    if (scroll.scrollTop+scroll.clientHeight >= scroll.scrollHeight-90 && nextRow<matches.length) addRows();
  },{passive:true});
  const toggle=$('search-toggle'), searchBar=document.querySelector('.search-bar');
  function setSearch(open) {
    searchBar.hidden=!open; toggle.hidden=open;
    toggle.setAttribute('aria-expanded',String(open));
    if (open) $('query').focus();
    else { $('query').value=''; refreshIndex(); toggle.focus(); }
  }
  toggle.addEventListener('click',()=>setSearch(true));
  $('close-search').addEventListener('click',()=>setSearch(false));
  $('query').addEventListener('input',refreshIndex);
  $('query').addEventListener('keydown',e=>{
    if (e.key==='Escape') { e.preventDefault(); setSearch(false); }
    if (e.key==='Enter' && matches.length) { e.preventDefault(); goToSite(matches[0]); map.focus({preventScroll:true}); }
  });
  function setLayer(kind, active) {
    layer[kind]=active;
    document.querySelector('[data-kind="'+kind+'"]').setAttribute('aria-pressed',String(active));
    if (selected?.kind===kind && !active) setSelection(null);
    invalidate();
  }
  for (const button of document.querySelectorAll('[data-kind]')) {
    button.addEventListener('click',()=>setLayer(button.dataset.kind,!layer[button.dataset.kind]));
  }

  const point = e => {const b=map.getBoundingClientRect(); return {x:e.clientX-b.left,y:e.clientY-b.top};};
  function worldAt(p) {
    const g=geometry();
    return {x:g.left+p.x/g.worldWidth,y:g.top+p.y/g.worldHeight};
  }
  function anchorAt(anchor, p, zoom) {
    view.zoom=limitZoom(zoom);
    view.x=anchor.x-(p.x/W-.5)/view.zoom;
    view.y=anchor.y-(p.y-H/2)/(W*view.zoom/2);
    normalize(); invalidate();
  }
  function zoomAt(p, factor) {
    flight=null; anchorAt(worldAt(p),p,view.zoom*factor);
  }
  function pickAt(p) {
    const y=worldAt(p).y;
    if (y<0 || y>1) return null;
    const label=labelHits.find(b=>p.x>=b.left && p.x<=b.right && p.y>=b.top && p.y<=b.bottom);
    if (label) return label.s;
    let best=null, threshold=W<440 ? 9 : 6;
    const g=geometry();
    for (const kind of ['fall','find']) {
      if (!layer[kind]) continue;
      for (const s of marks[kind]) {
        const dy=(s.y-g.top)*g.worldHeight-p.y;
        if (Math.abs(dy)>threshold) continue;
        const dist=Math.hypot(visibleX(s.x,g)-p.x,dy);
        if (dist < threshold) { best=s; threshold=dist; }
      }
    }
    return best;
  }
  const pointers=new Map();
  let gesture=null;
  const midpoint=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  function startGesture(tap) {
    const [a,b]=pointers.values();
    if (!a) { gesture=null; return; }
    const p=b ? midpoint(a,b) : a;
    gesture={anchor:worldAt(p),start:p,zoom:view.zoom,span:b ? Math.max(1,distance(a,b)) : 1,tap:tap && !b};
  }
  map.addEventListener('pointerdown',e=>{
    if (e.button!==0) return;
    flight=null; map.focus({preventScroll:true}); map.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId,point(e)); startGesture(pointers.size===1); map.classList.add('dragging');
  });
  map.addEventListener('pointermove',e=>{
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId,point(e));
    const [a,b]=pointers.values();
    const p=b ? midpoint(a,b) : a;
    if (distance(p,gesture.start)>4) gesture.tap=false;
    anchorAt(gesture.anchor,p,gesture.zoom*(b ? distance(a,b)/gesture.span : 1));
  });
  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    const p=point(e), tap=e.type==='pointerup' && gesture?.tap && distance(p,gesture.start)<5;
    pointers.delete(e.pointerId); startGesture(false); map.classList.toggle('dragging',pointers.size>0);
    if (tap) {
      const site=pickAt(p);
      if (site) goToSite(site);
      else if (selected) { setSelection(null); invalidate(); }
    }
  }
  for (const type of ['pointerup','pointercancel','lostpointercapture']) map.addEventListener(type,endPointer);
  map.addEventListener('wheel',e=>{
    e.preventDefault();
    const delta=e.deltaY*(e.deltaMode===1 ? 16 : e.deltaMode===2 ? H : 1);
    zoomAt(point(e),Math.exp(-clamp(delta*(e.ctrlKey ? .009 : .0025),-.72,.72)));
  },{passive:false});
  map.addEventListener('dblclick',e=>{
    e.preventDefault(); if (!pickAt(point(e))) zoomAt(point(e),e.shiftKey ? .5 : 2);
  });
  map.addEventListener('keydown',e=>{
    const step=(e.shiftKey ? .32 : .085)/view.zoom;
    const arrows={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]};
    if (arrows[e.key]) {
      e.preventDefault(); flight=null; const [x,y]=arrows[e.key];
      view.x+=x; view.y+=y; normalize(); invalidate();
    } else if (['+','=','-','_'].includes(e.key)) {
      e.preventDefault(); zoomAt({x:W/2,y:H/2},['-','_'].includes(e.key) ? 1/1.65 : 1.65);
    } else if (e.key==='Home') {
      e.preventDefault(); setSelection(null); flyTo(home);
    } else if (e.key==='Escape') {
      setSelection(null); invalidate();
    }
  });
  for (const button of locators) {
    button.addEventListener('click',e=>{
      const meridian=Number(button.dataset.meridian);
      const b=button.querySelector('.globe').getBoundingClientRect();
      const x=(e.clientX-b.left)*2/b.width-1, y=1-(e.clientY-b.top)*2/b.height;
      let lon=meridian, lat=0;
      if (e.detail && x*x+y*y<=1) {
        lon+=Math.atan2(x,Math.sqrt(Math.max(0,1-x*x-y*y)))/rad;
        lat=Math.asin(y)/rad;
      }
      setSelection(null); flyTo({x:(lon+180)/360,y:latitudeY(lat),zoom:Math.max(2.2,view.zoom)});
    });
  }
  function fitSheet() {
    const sheet = document.querySelector('.sheet');
    const notes = document.querySelector('.note-space');
    const css = getComputedStyle(sheet);
    const width = sheet.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    const height = sheet.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const horizontal = css.flexDirection === 'row';
    sheet.toggleAttribute('data-foot', !horizontal);
    let mapWidth;
    if (horizontal) {
      const rail = notes.getBoundingClientRect().width;
      mapWidth = Math.min(height, width - rail - parseFloat(css.columnGap), 1340);
    } else {
      const room = height - parseFloat(css.rowGap);
      // Three columns need room for complete coordinate pairs and scale marks.
      const minFooter = Math.min(width, (width >= 550 ? 64 : 31) * parseFloat(css.fontSize));
      let footer = Math.min(width, 1340);
      // Align the bottom legend to the map. Re-measure when narrower
      // columns wrap. Short windows keep enough width for the coordinates.
      for (let pass = 0; pass < 4; pass++) {
        notes.style.setProperty('--foot-width', footer + 'px');
        mapWidth = Math.min(width, room - notes.getBoundingClientRect().height, 1340);
        const next = Math.max(minFooter, Math.floor(mapWidth));
        if (next >= footer - 1) break;
        footer = next;
      }
    }
    sheet.style.setProperty('--map-width', Math.max(1, Math.floor(mapWidth)) + 'px');
    resize();
  }
  function resize() {
    const style=getComputedStyle(document.body);
    chartFont=style.fontWeight+' '+style.fontSize+' '+style.fontFamily;
    letterSize=parseFloat(style.fontSize);
    W=map.clientWidth;
    H=map.clientHeight;
    if (!W || !H) return;
    dpr=Math.min(window.devicePixelRatio||1,2);
    sizeCanvas(terrain,W,H); sizeCanvas(linework,W,H); invalidate();
  }
  function terrainReady() { $('load-status').hidden=true; invalidate(); }
  earth.addEventListener('load',terrainReady);
  earth.addEventListener('error',()=>{ $('load-status').textContent='Earth relief unavailable'; });
  if (earth.complete && earth.naturalWidth) terrainReady();
  refreshIndex();
  const observer=new ResizeObserver(fitSheet);
  observer.observe(document.querySelector('.sheet')); observer.observe(document.querySelector('.note-space'));
  window.addEventListener('resize',fitSheet);
  window.addEventListener('beforeprint',()=>{ flight=null; fitSheet(); render(performance.now()); });
  window.addEventListener('afterprint',fitSheet);
  document.fonts.ready.then(fitSheet);
  fitSheet();
})();
