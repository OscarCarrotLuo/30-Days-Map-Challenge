(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const data = window.MOON_ZOO;
  const map = $('map'), photo = $('photo');
  const canvas = $('terrain'), tip = $('map-tip');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const expertByID = new Map(data.expert.map(row => [row[0], row]));
  const marksByID = new Map(data.volunteer.map(row => [row[0], row]));
  const named = data.index.map(entry => ({...entry, ring: expertByID.get(entry.record)}));
  const byRecord = new Map(named.map(entry => [entry.record, entry]));
  const membership = new Map(named.flatMap(entry => entry.marks.map(id => [id, entry])));
  const SIDE = data.side;
  const thumbnail = document.createElement('canvas');
  thumbnail.width = thumbnail.height = 160;
  let thumbnailReady = false;
  const homeCrater = named[0];
  const initial = {x: homeCrater.ring[1] - 155, y: homeCrater.ring[2] + 102, span: 1460};
  let view = {...initial}, selected = homeCrater, inspecting = null;
  let W = 1, H = 1, dpr = 1, chartFont, letterSize;
  let dirty = false, visible = [], labels = [], hovered = null;
  const layers = {volunteer:true, expert:true};
  const pointers = new Map();
  let moved = false, anchor = null;
  const percent = value => Math.round(value*100) + '%';
  const coordinate = (v, lat, places = 3) => v.toFixed(places) + (lat ? '°N' : '°E');
  const worldLon = x => data.west + x / data.metresLon;
  const worldLat = y => data.north - y / data.metresLat;
  const xAt = x => W/2 + (x-view.x)*W/view.span;
  const yAt = y => H/2 + (y-view.y)*H/view.span;

  function limitView() {
    view.span = clamp(view.span, 120, SIDE);
    const half = view.span/2;
    view.x = clamp(view.x, half, SIDE-half);
    view.y = clamp(view.y, half, SIDE-half);
  }
  function sizeCanvas(element, w, h) {
    const pw = Math.round(w*dpr), ph = Math.round(h*dpr);
    if (element.width !== pw || element.height !== ph) { element.width = pw; element.height = ph; }
    const ctx = element.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0);
    return ctx;
  }
  function invalidate() {
    if (!dirty) { dirty = true; requestAnimationFrame(render); }
  }
  function clearTip() {
    tip.hidden = true;
    if (hovered) { hovered = null; invalidate(); }
  }
  function projectView() {
    const half = view.span/2;
    return {west:worldLon(view.x-half), east:worldLon(view.x+half),
      north:worldLat(view.y-half), south:worldLat(view.y+half),
      sx:data.metresLon*W/view.span, sy:data.metresLat*H/view.span,
      groundPerPixel:view.span/W * Math.cos(worldLat(view.y)*Math.PI/180)/Math.cos(20*Math.PI/180)};
  }
  const steps = [.0005,.001,.002,.0025,.005,.01,.02,.025,.05,.1];
  const nearestStep = n => steps.reduce((a,b) => Math.abs(Math.log(a/n)) < Math.abs(Math.log(b/n)) ? a : b);
  function drawAxis(isLatitude, step, g) {
    const canvas = $(isLatitude ? 'latitude' : 'longitude');
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const ctx = sizeCanvas(canvas, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.font = chartFont;
    ctx.fillStyle = '#444';
    ctx.strokeStyle = '#777';
    ctx.lineWidth = .7;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const low = isLatitude ? g.south : g.west;
    const high = isLatitude ? g.north : g.east;
    const ticks = [];
    ctx.beginPath();
    for (let i = Math.ceil(low * 10 / step - 1e-8); i <= Math.floor(high * 10 / step + 1e-8); i++) {
      const value = i * step / 10;
      const pos = isLatitude ? (g.north - value) * g.sy : (value - g.west) * g.sx;
      const major = i % 10 === 0;
      const length = major ? 6 : i % 5 === 0 ? 4 : 2;
      if (isLatitude) {ctx.moveTo(w, pos); ctx.lineTo(w - length, pos);}
      else {ctx.moveTo(pos, 0); ctx.lineTo(pos, length);}
      if (major) ticks.push([value, pos]);
    }
    ctx.stroke();
    for (const [value, pos] of ticks) {
      const label = coordinate(value, isLatitude, step < .001 ? 4 : 3);
      const half = ctx.measureText(label).width / 2 + 2;
      if (pos < half || pos > (isLatitude ? h : w) - half) continue;
      ctx.save();
      const thickness = isLatitude ? w : h;
      const inset = Math.min(7 + letterSize * .56, thickness - letterSize * .65 - 1);
      if (isLatitude) {ctx.translate(w - inset, pos); ctx.rotate(-Math.PI / 2);}
      else ctx.translate(pos, inset);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
    return ticks.map(t => t[1]);
  }
  function registration(g, overlay) {
    const spacing = clamp(W / 3.7, 90, 235);
    const xs = drawAxis(false, nearestStep(spacing / g.sx), g);
    const ys = drawAxis(true, nearestStep(spacing / g.sy), g);
    overlay.beginPath();
    for (const x of xs) {overlay.moveTo(x, 0); overlay.lineTo(x, H);}
    for (const y of ys) {overlay.moveTo(0, y); overlay.lineTo(W, y);}
    overlay.lineWidth = 1.1;
    overlay.strokeStyle = 'rgba(32,32,32,.2)';
    overlay.stroke();
    overlay.lineWidth = .55;
    overlay.strokeStyle = 'rgba(255,255,255,.48)';
    overlay.stroke();
    overlay.beginPath();
    for (const x of xs) for (const y of ys) {
      overlay.moveTo(x - 2, y - 3);
      overlay.lineTo(x + 2, y + 3);
    }
    overlay.lineWidth = .9;
    overlay.strokeStyle = '#fff';
    overlay.stroke();
  }
  function drawScale(g) {
    const canvas = $('scale'), width = canvas.clientWidth, height = canvas.clientHeight;
    const ctx = sizeCanvas(canvas, width, height);
    ctx.clearRect(0, 0, width, height);
    // One subdivided unit left of zero, with full units to the right.
    const available = width - 4 * letterSize;
    if (available <= 0) return;
    const maxStep = available * g.groundPerPixel / 5;
    const power = 10 ** Math.floor(Math.log10(maxStep));
    const step = [1, 2, 2.5, 5, 10].filter(v => v * power <= maxStep).pop() * power;
    const stepPx = step / g.groundPerPixel;
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
    canvas.setAttribute('aria-label','Graphic scale, '+step+' metres per major division, '+(divisions * step)+' metres to the right of zero');
  }
  function fitSheet() {
    const sheet = document.querySelector('.sheet');
    const notes = document.querySelector('.note-space');
    const css = getComputedStyle(sheet);
    const width = sheet.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    const height = sheet.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const horizontal = css.flexDirection === 'row';
    sheet.toggleAttribute('data-foot', !horizontal);
    let side;
    if (horizontal) {
      const rail = notes.getBoundingClientRect().width;
      side = Math.min(height, width - rail - parseFloat(css.columnGap), 1340);
    } else {
      const room = height - parseFloat(css.rowGap);
      // Three columns need room for complete coordinate pairs and scale marks.
      const minFooter = Math.min(width, (width >= 550 ? 64 : 31) * parseFloat(css.fontSize));
      let footer = Math.min(width, 1340);
      // Align the bottom legend to the square. Re-measure when narrower
      // columns wrap. Short windows keep enough width for the coordinates.
      for (let pass = 0; pass < 4; pass++) {
        notes.style.setProperty('--foot-width', footer + 'px');
        side = Math.min(width, room - notes.getBoundingClientRect().height, 1340);
        const next = Math.max(minFooter, Math.floor(side));
        if (next >= footer - 1) break;
        footer = next;
      }
    }
    side = Math.max(1, Math.floor(side));
    sheet.style.setProperty('--side',side + 'px');
    resize();
  }
  function resize() {
    const css = getComputedStyle(document.body);
    letterSize = parseFloat(css.fontSize);
    chartFont = css.fontWeight + ' ' + css.fontSize + ' ' + css.fontFamily;
    W = map.clientWidth; H = map.clientHeight;
    dpr = Math.min(devicePixelRatio || 1, 3);
    clearTip(); invalidate();
  }

  function locators() {
    const c = $('near-grid'), d = c.clientWidth, r = d/2;
    const ctx = sizeCanvas(c,d,d);
    ctx.clearRect(0,0,d,d);
    const rad = Math.PI/180;
    const pt = (lon,lat) => [r+r*Math.cos(lat*rad)*Math.sin(lon*rad), r-r*Math.sin(lat*rad)];
    ctx.beginPath();
    for (const lon of [-60,0,60]) {
      for (let lat=-90; lat<=90; lat+=3) {
        const p = pt(lon,lat);
        if (lat===-90) ctx.moveTo(...p); else ctx.lineTo(...p);
      }
    }
    for (const lat of [-45,0,45]) { ctx.moveTo(...pt(-90,lat)); ctx.lineTo(...pt(90,lat)); }
    ctx.strokeStyle = 'rgba(255,255,255,.54)'; ctx.lineWidth=.45; ctx.stroke();
    const [x,y] = pt(worldLon(view.x),worldLat(view.y));
    ctx.fillStyle = '#fff'; ctx.fillRect(x-2.2,y-2.2,4.4,4.4);
    ctx.fillStyle = '#a34432'; ctx.fillRect(x-1.25,y-1.25,2.5,2.5);
    const s = $('survey-window'), w = s.clientWidth;
    const local = sizeCanvas(s,w,w);
    if (!photo.naturalWidth) return;
    if (!thumbnailReady) {
      thumbnail.getContext('2d').drawImage(photo,0,0,160,160); thumbnailReady=true;
    }
    local.drawImage(thumbnail,0,0,w,w);
    const factor=w/SIDE, box=view.span*factor;
    const lx=(view.x-view.span/2)*factor, ly=(view.y-view.span/2)*factor;
    local.strokeStyle='#fff'; local.lineWidth=2.3; local.strokeRect(lx,ly,box,box);
    local.strokeStyle='#ae3b29'; local.lineWidth=1.15; local.strokeRect(lx,ly,box,box);
  }

  function inFrame(row) {
    const dx = Math.abs(row[1]-view.x), dy = Math.abs(row[2]-view.y), half = view.span/2;
    if (dx > half+row[3] || dy > half+row[3]) return false;
    return Math.hypot(Math.max(0,dx-half),Math.max(0,dy-half)) <= row[3] &&
      Math.hypot(dx+half,dy+half) >= row[3];
  }
  function strokeRing(ctx,row) {
    ctx.beginPath();
    ctx.arc(xAt(row[1]), yAt(row[2]), row[3]*W/view.span, 0, 2*Math.PI);
    ctx.stroke();
  }
  function drawRings(ctx,kind) {
    if (!layers[kind]) return;
    const blue = kind === 'volunteer';
    ctx.strokeStyle = blue ? 'rgba(164,220,252,.54)' : '#ff9849';
    ctx.lineWidth = blue ? .62 : 1.24;
    for (const row of data[kind]) {
      if (!inFrame(row)) continue;
      strokeRing(ctx,row);
      visible.push({row,kind});
    }
  }
  function drawNames(ctx) {
    labels=[];
    ctx.font=chartFont; ctx.textBaseline='middle';
    const order = [selected, ...named.filter(n => n!==selected)];
    for (const entry of order) {
      const row=entry.ring, x=xAt(row[1]), y=yAt(row[2]), rp=row[3]*W/view.span;
      if (x<8 || x>W-8 || y<12 || y>W-12 || (rp<12 && entry!==selected)) continue;
      const width=ctx.measureText(entry.name).width;
      const sign=x+width+22 < W-4 ? 1 : -1;
      const lx=sign>0 ? x+16 : x-16-width, ly=y-7;
      const box={left:lx-3, top:ly-letterSize*.8, right:lx+width+3, bottom:ly+letterSize*.8, entry};
      if (labels.some(b => box.left<b.right+5 && box.right>b.left-5 && box.top<b.bottom+4 && box.bottom>b.top-4)) continue;
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+6*sign,y-7); ctx.lineTo(x+14*sign,y-7);
      ctx.strokeStyle='rgba(20,22,22,.7)'; ctx.lineWidth=1.7; ctx.stroke();
      ctx.strokeStyle='white'; ctx.lineWidth=.7; ctx.stroke();
      ctx.fillStyle='#fff'; ctx.fillRect(x-1,y-1,2,2);
      ctx.lineJoin='round'; ctx.lineWidth=1.8; ctx.strokeStyle='rgba(30,30,30,.64)';
      ctx.strokeText(entry.name,lx,ly); ctx.fillText(entry.name,lx,ly);
      labels.push(box);
      if (labels.length===4) break;
    }
  }
  function render() {
    dirty=false; limitView();
    const ctx=sizeCanvas(canvas,W,H), g=projectView();
    if (photo.naturalWidth) {
      const ratio=photo.naturalWidth/SIDE;
      ctx.drawImage(photo,(view.x-view.span/2)*ratio,(view.y-view.span/2)*ratio,
        view.span*ratio,view.span*ratio,0,0,W,H);
      $('load-status').hidden=true;
    } else { ctx.fillStyle='#555'; ctx.fillRect(0,0,W,H); }
    registration(g,ctx);
    visible=[]; drawRings(ctx,'volunteer'); drawRings(ctx,'expert');
    if (hovered && layers[hovered.kind]) {
      ctx.strokeStyle=hovered.kind==='expert' ? '#ffbd77' : '#d8f3ff';
      ctx.lineWidth=1.65;
      strokeRing(ctx,hovered.row);
    }
    drawNames(ctx); drawScale(g); locators();
    $('position').textContent=coordinate(worldLat(view.y),true,4)+' / '+coordinate(worldLon(view.x),false,4);
  }
  function updateReading() {
    const el=$('reading');
    el.replaceChildren();
    const top=document.createElement('span');
    top.textContent=selected.name+' · expert Ø '+Math.round(selected.ring[3]*2)+' m';
    const bottom=document.createElement('span');
    bottom.textContent='Volunteer median Ø '+Math.round(selected.medianDiameter)+' m';
    el.append(top,bottom);
    for (const tr of $('feature-rows').rows) {
      if (+tr.dataset.id===selected.record) tr.setAttribute('aria-current','true');
      else tr.removeAttribute('aria-current');
    }
  }
  function visit(entry) {
    selected=entry; inspecting=null; clearTip();
    view={x:entry.ring[1], y:entry.ring[2], span:Math.max(240,entry.ring[3]*4.15)};
    updateReading(); limitView(); invalidate();
  }
  function home() {
    selected=homeCrater; inspecting=null; clearTip(); view={...initial};
    updateReading(); invalidate();
  }
  for (const entry of named) {
    const tr=$('feature-rows').insertRow(), b=document.createElement('button');
    tr.dataset.id=entry.record; b.type='button'; b.textContent=entry.name;
    b.setAttribute('aria-label','Inspect '+entry.name+', '+entry.marks.length+' marks, '+percent(entry.medianOverlap)+' median overlap');
    tr.insertCell().append(b); tr.insertCell().textContent=entry.marks.length;
    tr.insertCell().textContent=percent(entry.medianOverlap);
    tr.addEventListener('click',() => visit(entry));
  }
  $('home').addEventListener('click',home);
  $('overview').addEventListener('click',() => { clearTip(); view={x:SIDE/2,y:SIDE/2,span:SIDE}; invalidate(); });
  for (const kind of ['volunteer','expert']) {
    const button=$(kind+'-layer');
    button.addEventListener('click',() => {
      layers[kind]=!layers[kind];
      button.setAttribute('aria-pressed',String(layers[kind]));
      inspecting=null; clearTip(); invalidate();
    });
  }

  const point = event => {
    const b=map.getBoundingClientRect();
    return {x:event.clientX-b.left,y:event.clientY-b.top};
  };
  function nameAt(p) {
    return labels.find(b => p.x>=b.left && p.x<=b.right && p.y>=b.top && p.y<=b.bottom)?.entry;
  }
  function ringAt(p) {
    let hit=null, best=4.5;
    for (const item of visible) {
      const row=item.row, r=row[3]*W/view.span;
      const err=Math.abs(Math.hypot(p.x-xAt(row[1]),p.y-yAt(row[2]))-r);
      if (err<best) { best=err; hit=item; }
    }
    return hit;
  }
  function showTip(hit,p) {
    if (!hit) {clearTip(); return;}
    hovered=hit;
    const [id,,,r]=hit.row, isExpert=hit.kind==='expert';
    const entry=isExpert ? byRecord.get(id) : membership.get(id);
    tip.textContent=(isExpert?'Expert rim':'Volunteer mark')+' #'+id
      +(entry?' · '+entry.name:'')+'\nDiameter '+Math.round(2*r)+' m';
    tip.hidden=false;
    const tx=p.x+10+tip.offsetWidth < W ? p.x+10 : p.x-tip.offsetWidth-10;
    tip.style.left=clamp(tx,2,W-tip.offsetWidth-2)+'px';
    tip.style.top=clamp(p.y+13,2,H-tip.offsetHeight-2)+'px';
    invalidate();
  }
  function stepMark(direction) {
    const ids=selected.marks;
    if (!layers.volunteer) $('volunteer-layer').click();
    if (!inFrame(selected.ring)) visit(selected);
    inspecting=inspecting===null ? (direction>0?0:ids.length-1) : (inspecting+direction+ids.length)%ids.length;
    const row=marksByID.get(ids[inspecting]);
    showTip({row,kind:'volunteer'},{x:clamp(xAt(row[1]+row[3]),0,W),y:clamp(yAt(row[2]),0,H)});
  }
  function zoomAt(factor,p) {
    const old=view.span, next=clamp(old*factor,120,SIDE);
    view.x+=(p.x/W-.5)*(old-next);
    view.y+=(p.y/H-.5)*(old-next);
    view.span=next; limitView(); clearTip(); invalidate();
  }
  map.addEventListener('wheel',e => {
    e.preventDefault();
    zoomAt(Math.exp(clamp(e.deltaY*(e.deltaMode===1?14:e.deltaMode===2?W:1),-250,250)*.0017),point(e));
  },{passive:false});
  const mid = (a,b) => ({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  const gap = (a,b) => Math.max(1,Math.hypot(a.x-b.x,a.y-b.y));
  map.addEventListener('pointerdown',e => {
    if (e.button!==0) return;
    const p=point(e); if (!pointers.size) {moved=false;anchor=p;} else moved=true;
    pointers.set(e.pointerId,p); map.setPointerCapture(e.pointerId);
    map.classList.add('dragging'); map.focus({preventScroll:true}); clearTip(); inspecting=null;
  });
  map.addEventListener('pointermove',e => {
    const p=point(e);
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType==='mouse' && pointers.size===0) showTip(ringAt(p),p);
      return;
    }
    const old=[...pointers.values()], prev=pointers.get(e.pointerId);
    pointers.set(e.pointerId,p);
    if (pointers.size===2) {
      const now=[...pointers.values()], a=mid(...old), b=mid(...now);
      zoomAt(gap(...old)/gap(...now),a);
      view.x+=(a.x-b.x)*view.span/W; view.y+=(a.y-b.y)*view.span/H;
    } else if (pointers.size===1) {
      if (Math.hypot(p.x-anchor.x,p.y-anchor.y)>3) moved=true;
      view.x-=(p.x-prev.x)*view.span/W; view.y-=(p.y-prev.y)*view.span/H;
    }
    limitView(); invalidate();
  });
  function release(e) {
    if (!pointers.has(e.pointerId)) return;
    const p=point(e);
    pointers.delete(e.pointerId);
    if (pointers.size) {moved=true;anchor=[...pointers.values()][0];return;}
    map.classList.remove('dragging');
    if (!moved && e.type==='pointerup') {
      const name=nameAt(p);
      if (name) return visit(name);
      showTip(ringAt(p),p);
    }
  }
  for (const type of ['pointerup','pointercancel','lostpointercapture']) map.addEventListener(type,release);
  map.addEventListener('pointerleave',() => { if (!pointers.size) clearTip(); });
  map.addEventListener('keydown',e => {
    const move=view.span*.1, centre={x:W/2,y:H/2};
    switch(e.key) {
      case 'ArrowLeft': view.x-=move; break;
      case 'ArrowRight': view.x+=move; break;
      case 'ArrowUp': view.y-=move; break;
      case 'ArrowDown': view.y+=move; break;
      case '+': case '=': zoomAt(.75,centre); break;
      case '-': case '_': zoomAt(1/.75,centre); break;
      case 'Home': home(); break;
      case '[': e.preventDefault();stepMark(-1);return;
      case ']': e.preventDefault();stepMark(1);return;
      case 'Escape': break;
      default: return;
    }
    e.preventDefault(); inspecting=null; clearTip(); limitView(); invalidate();
  });
  map.addEventListener('blur',clearTip);
  $('open-method').addEventListener('click',() => $('method').showModal());
  photo.addEventListener('load',invalidate);
  photo.addEventListener('error',() => { $('load-status').hidden=false; $('load-status').textContent='Image unavailable'; });
  updateReading(); fitSheet();
  document.fonts.ready.then(fitSheet);
  window.addEventListener('resize',fitSheet);
})();
