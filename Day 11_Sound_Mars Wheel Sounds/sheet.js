(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const sheet = document.querySelector('.sheet');
  const rail = document.querySelector('.note-space');
  const map = $('map'), ortho = $('ortho');
  const audio = $('audio'), seek = $('seek');
  const ink = '#232321', red = '#983b35';
  const overview = {x: 26, y: 17, span: 91};
  const view = {...overview};
  const drives = survey.drives;
  const start = drives[0].xy[0];
  let selectedSol = null, side = 1, letter = 10, type = 'ChartBarlow, Arial, sans-serif';
  let mapFrame = 0, audioFrame = 0, layoutFrame = 0;
  const clamp = (value, lo, hi) => Math.max(lo, Math.min(value, hi));
  const origin = survey.origin, degrees = survey.metresPerDegree;
  const toScreen = ([x,y]) => [(x-view.x)*side/view.span + side/2, (view.y-y)*side/view.span + side/2];
  const toWorld = (x,y) => [view.x + (x/side-.5)*view.span, view.y - (y/side-.5)*view.span];
  const degreeText = (value, axis, digits=4) => value.toFixed(digits) + '°' + axis;
  const chartFont = (bold=false) => `${bold ? 700 : 500} ${letter}px ${type}`;
  const orthoReady = () => ortho.complete && ortho.naturalWidth > 0;

  function context(canvas) {
    const box = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 3);
    const w = box.width, h = box.height;
    const pixelsX = Math.max(1, Math.round(w*ratio)), pixelsY = Math.max(1, Math.round(h*ratio));
    if (canvas.width !== pixelsX || canvas.height !== pixelsY) {
      canvas.width = pixelsX; canvas.height = pixelsY;
    }
    const ctx = canvas.getContext('2d');
    if (w && h) ctx.setTransform(pixelsX/w, 0, 0, pixelsY/h, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return {ctx, w, h};
  }

  function layout() {
    layoutFrame = 0;
    const css = getComputedStyle(sheet);
    letter = parseFloat(css.fontSize); type = css.fontFamily;
    const width = sheet.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    const height = window.innerHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const horizontal = css.flexDirection === 'row';
    sheet.toggleAttribute('data-foot', !horizontal);
    if (horizontal) {
      side = Math.min(height, width - rail.getBoundingClientRect().width - parseFloat(css.columnGap), 1340);
    } else {
      const minFooter = Math.min(width, (width >= 550 ? 64 : 31)*letter);
      let footer = Math.min(width, 1340);
      for (let pass=0; pass<4; pass++) {
        rail.style.setProperty('--foot-width', footer+'px');
        const available = height - parseFloat(css.rowGap) - rail.getBoundingClientRect().height;
        // Small portrait displays retain a readable map and may scroll the paper.
        side = Math.min(width, Math.max(Math.min(width, 270), available), 1340);
        const next = Math.max(minFooter, Math.floor(side));
        if (next >= footer-1) break;
        footer = next;
      }
    }
    side = Math.max(1, Math.floor(side));
    sheet.style.setProperty('--side', side+'px');
    side = map.getBoundingClientRect().width;
    draw(); drawWave();
  }
  function queueLayout() { if (!layoutFrame) layoutFrame = requestAnimationFrame(layout); }
  function invalidate() { if (!mapFrame) mapFrame = requestAnimationFrame(draw); }
  function niceStep(goal, steps=[1,2,2.5,5,10]) {
    const power = 10 ** Math.floor(Math.log10(goal));
    return (steps.find(n => n*power >= goal-1e-12) || 10)*power;
  }
  function degreeAxes(ctx) {
    const leftAxis = context($('latitude')), bottom = context($('longitude'));
    const west = view.x-view.span/2, south = view.y-view.span/2;
    for (const horizontal of [true,false]) {
      const axis = horizontal ? bottom : leftAxis;
      const k = horizontal ? 0 : 1;
      const min = origin[k] + (horizontal ? west : south)/degrees[k];
      const spread = view.span/degrees[k];
      const step = niceStep(spread/4.8, [1,2,5,10]);
      const digits = Math.max(3, Math.ceil(-Math.log10(step)-1e-8));
      const pencil = axis.ctx;
      pencil.font = chartFont(); pencil.fillStyle = ink; pencil.textAlign = 'center';
      pencil.strokeStyle = ink; pencil.lineWidth = .7;
      const first = Math.ceil((min-1e-11)/step);
      for (let n=first; n*step < min+spread+1e-11; n++) {
        const value = n*step;
        const pos = (horizontal ? (value-min)/spread : 1-(value-min)/spread)*side;
        ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,.38)'; ctx.lineWidth = .57;
        if (horizontal) { ctx.moveTo(pos,0); ctx.lineTo(pos,side); }
        else { ctx.moveTo(0,pos); ctx.lineTo(side,pos); }
        ctx.stroke();
        pencil.beginPath();
        if (horizontal) { pencil.moveTo(pos,0); pencil.lineTo(pos,2.8); }
        else { pencil.moveTo(axis.w,pos); pencil.lineTo(axis.w-2.8,pos); }
        pencil.stroke();
        const text = degreeText(value, horizontal ? 'E' : 'N', digits);
        const half = pencil.measureText(text).width/2 + 1;
        if (pos < half || pos > side-half) continue;
        pencil.save(); pencil.textBaseline = 'middle';
        if (horizontal) pencil.fillText(text, pos, letter*.78+2.8);
        else { pencil.translate(axis.w-letter*.78-2.8,pos); pencil.rotate(-Math.PI/2); pencil.fillText(text,0,0); }
        pencil.restore();
      }
    }
  }
  const relief = survey.contours.map(([height,flat]) => {
    const path = new Path2D();
    path.moveTo(flat[0],flat[1]);
    for (let i=2; i<flat.length; i+=2) path.lineTo(flat[i],flat[i+1]);
    return {height,path};
  });
  function contours(ctx) {
    const metresToPixels = side/view.span;
    ctx.save(); ctx.translate(side/2,side/2); ctx.scale(metresToPixels,-metresToPixels);
    ctx.translate(-view.x,-view.y); ctx.lineJoin='round';
    for (const {height,path} of relief) {
      const wholeMetre = Number.isInteger(height);
      ctx.lineWidth = (wholeMetre ? .77 : .56)/metresToPixels;
      ctx.strokeStyle = wholeMetre ? 'rgba(255,255,255,.67)' : 'rgba(255,255,255,.46)';
      ctx.stroke(path);
    }
    ctx.restore();
  }
  function strokeDrive(ctx, coords, color, width) {
    ctx.beginPath();
    coords.forEach((point,i) => { const [x,y] = toScreen(point); if (i) ctx.lineTo(x,y); else ctx.moveTo(x,y); });
    ctx.strokeStyle=color; ctx.lineWidth=width; ctx.stroke();
  }
  function circle(ctx,x,y,r,fill,stroke,width=1) {
    ctx.beginPath(); ctx.arc(x,y,r,0,2*Math.PI);
    if (fill) { ctx.fillStyle=fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle=stroke; ctx.lineWidth=width; ctx.stroke(); }
  }
  function terrainLabel(ctx, text, pos, dx, dy, bold=false) {
    const [x,y] = toScreen(pos);
    ctx.save(); ctx.font=chartFont(bold); ctx.textAlign=dx<0?'right':'left'; ctx.textBaseline='middle';
    const clear = .3*letter, w = ctx.measureText(text).width;
    const px=x+dx*letter, py=y+dy*letter;
    // Labels leave the plate with their fix when a reader zooms or pans.
    if (x<0 || x>side || y<0 || y>side || py<letter/2 || py>side-letter/2 ||
        (dx<0 ? px-w<0 : px+w>side)) { ctx.restore(); return; }
    const tx = px + (dx<0 ? clear : -clear);
    ctx.beginPath(); ctx.moveTo(x + Math.sign(dx)*letter*.44, y+Math.sign(dy)*letter*.35);
    ctx.lineTo(tx,py); ctx.strokeStyle='rgba(255,255,255,.9)'; ctx.lineWidth=.65; ctx.stroke();
    ctx.strokeStyle='rgba(35,35,33,.89)'; ctx.lineJoin='round'; ctx.lineWidth=2.6;
    ctx.strokeText(text,px,py); ctx.fillStyle='white'; ctx.fillText(text,px,py); ctx.restore();
  }
  function drawDrives(ctx) {
    ctx.lineCap='round'; ctx.lineJoin='round';
    for (const d of drives) {
      if (d.sol===16) continue;
      const width = selectedSol===d.sol ? .30*letter : .205*letter;
      strokeDrive(ctx,d.xy,'rgba(39,38,36,.77)',width+1.6);
      strokeDrive(ctx,d.xy,'#fff',width);
    }
    const recording = drives.find(d => d.sol===16);
    strokeDrive(ctx, recording.xy, '#fff', letter*.66);
    strokeDrive(ctx, recording.xy, red, letter*.42);
    for (const d of drives) {
      const [x,y] = toScreen(d.xy.at(-1));
      const boundary = d.sol===15 || d.sol===16;
      circle(ctx,x,y,letter*(boundary ? .49 : .32),boundary ? red : '#fff',boundary ? '#fff' : '#343432',boundary ? 1.35 : .85);
      if (boundary) circle(ctx,x,y,letter*.135,'white');
      if (selectedSol===d.sol) circle(ctx,x,y,letter*.85,null,'#fff',.9);
    }
    const [x,y] = toScreen(start), half = letter*.34;
    ctx.fillStyle='#fff'; ctx.strokeStyle='#383735'; ctx.lineWidth=1.05;
    ctx.fillRect(x-half,y-half,2*half,2*half); ctx.strokeRect(x-half,y-half,2*half,2*half);
    // The labels mark end-of-drive fixes. The two circles on the recorded leg mark its limits.
    terrainLabel(ctx, 'Octavia E. Butler Landing', start, 1.55,-1.50);
    terrainLabel(ctx, 'Sol 14', drives[0].xy.at(-1), 1.2,1.6);
    terrainLabel(ctx, 'Sol 15', drives[1].xy.at(-1), -1.45,.98);
    terrainLabel(ctx, 'Sol 16', drives[2].xy.at(-1), 1.05,-1.65,true);
    terrainLabel(ctx, 'Sol 20', drives[3].xy.at(-1), 1.0,1.45);
  }
  function drawScale() {
    const {ctx,w,h} = context($('scale'));
    const available = w-3.4*letter, metresPerPixel=view.span/side;
    if (available<10) return;
    const maxStep = available*metresPerPixel/4.6;
    const power=10**Math.floor(Math.log10(maxStep));
    const step = [1,2,2.5,5,10].filter(v=>v*power<=maxStep).at(-1)*power;
    const gap=step/metresPerPixel, parts=Math.min(6,Math.floor(available/gap+1e-8)-1);
    const length=(parts+1)*gap, x=(w-length)/2, zero=x+gap, base=h-3;
    ctx.strokeStyle=ink; ctx.fillStyle=ink; ctx.lineWidth=.65; ctx.strokeRect(x,base-1.65,length,1.65);
    for (let i=0;i<5;i+=2) ctx.fillRect(x+gap*i/5,base-1.65,gap/5,1.65);
    for (let i=0;i<parts;i+=2) ctx.fillRect(zero+gap*i,base-1.65,gap,1.65);
    ctx.font=chartFont(); ctx.textAlign='center'; ctx.textBaseline='bottom'; ctx.beginPath();
    for (let i=-1;i<=parts;i++) {
      const px=zero+i*gap;
      ctx.moveTo(px,base+.65); ctx.lineTo(px,base-4);
      ctx.fillText(String(Number((Math.abs(i)*step).toPrecision(5))),px,base-4);
    }
    ctx.stroke(); $('scale').setAttribute('aria-label', `Scale in metres, ${step} metres per major division`);
  }
  function cross(id, point) {
    $(id).style.left=(point[0]*100)+'%'; $(id).style.top=(point[1]*100)+'%';
  }
  function draw() {
    mapFrame = 0;
    const {ctx,w} = context($('terrain')); side=w;
    if (side<2) return;
    const minX = view.x-view.span/2, maxY=view.y+view.span/2;
    if (orthoReady()) {
      const density=ortho.naturalWidth/survey.span;
      ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
      ctx.drawImage(ortho,(minX-survey.west)*density,(survey.north-maxY)*density,view.span*density,view.span*density,0,0,side,side);
    }
    contours(ctx); degreeAxes(ctx); drawDrives(ctx); drawScale();
    $('position').textContent = degreeText(origin[1]+view.y/degrees[1],'N',5)+' / '+degreeText(origin[0]+view.x/degrees[0],'E',5);
  }
  function bounds() {
    const r = view.span/2;
    view.x=clamp(view.x,survey.west+r,survey.west+survey.span-r);
    view.y=clamp(view.y,survey.north-survey.span+r,survey.north-r);
  }
  function zoomAt(x, y, span, fixed=toWorld(x,y)) {
    view.span=clamp(span,18,survey.span);
    view.x=fixed[0]-(x/side-.5)*view.span;
    view.y=fixed[1]+(y/side-.5)*view.span;
    bounds(); invalidate();
  }
  function clearSelection() {
    selectedSol=null;
    for (const row of $('drive-rows').rows) {
      row.classList.remove('is-selected'); row.querySelector('button').setAttribute('aria-pressed','false');
    }
  }
  function resetMap() { clearSelection(); Object.assign(view,overview); invalidate(); }
  function selectDrive(d, tr) {
    clearSelection(); selectedSol=d.sol;
    tr.classList.add('is-selected'); tr.querySelector('button').setAttribute('aria-pressed','true');
    const xs=d.xy.map(p=>p[0]), ys=d.xy.map(p=>p[1]);
    const xmin=Math.min(...xs), xmax=Math.max(...xs), ymin=Math.min(...ys), ymax=Math.max(...ys);
    Object.assign(view,{x:(xmin+xmax)/2, y:(ymin+ymax)/2, span: Math.max(32,(xmax-xmin)*1.65,(ymax-ymin)*1.65)});
    bounds(); invalidate();
  }
  for (const d of drives) {
    const tr=$('drive-rows').insertRow(); if (d.sol===16) tr.className='recorded';
    const sol=tr.insertCell(), btn=document.createElement('button'); btn.type='button'; btn.textContent=d.sol;
    btn.setAttribute('aria-label',`Focus on Sol ${d.sol}${d.sol===16?', the recorded drive':''}`); btn.setAttribute('aria-pressed','false');
    sol.append(btn); tr.insertCell().textContent=d.metres.toFixed(2); tr.insertCell().textContent=d.total.toFixed(2);
    tr.addEventListener('click',()=>selectDrive(d,tr));
  }
  $('overview').addEventListener('click',resetMap);
  cross('globe-fix',survey.globeFix); cross('crater-fix',survey.craterFix);

  const pointers = new Map(); let gesture=null;
  function mapPoint(e) { const box=map.getBoundingClientRect(); return [e.clientX-box.left,e.clientY-box.top]; }
  function touchPair() {
    const [a,b]=pointers.values();
    return {x:(a[0]+b[0])/2,y:(a[1]+b[1])/2,separation:Math.max(1,Math.hypot(a[0]-b[0],a[1]-b[1]))};
  }
  function startGesture() {
    map.classList.toggle('dragging',pointers.size>0); gesture=null;
    if (pointers.size>=2) {
      const p=touchPair(); gesture={...p,span:view.span,anchor:toWorld(p.x,p.y)};
    } else if (pointers.size===1) {
      const [x,y]=pointers.values().next().value; gesture={x,y,east:view.x,north:view.y};
    }
  }
  map.addEventListener('pointerdown',e=>{
    if (e.button!==0) return;
    map.setPointerCapture(e.pointerId); pointers.set(e.pointerId,mapPoint(e)); startGesture();
  });
  map.addEventListener('pointermove',e=>{
    if (!pointers.has(e.pointerId) || !gesture) return;
    const [x,y]=mapPoint(e); pointers.set(e.pointerId,[x,y]);
    if (pointers.size>=2) {
      const p=touchPair(); zoomAt(p.x,p.y,gesture.span*gesture.separation/p.separation,gesture.anchor);
    } else {
      view.x=gesture.east-(x-gesture.x)*view.span/side; view.y=gesture.north+(y-gesture.y)*view.span/side;
      bounds(); invalidate();
    }
  });
  function release(e) { if (pointers.delete(e.pointerId)) startGesture(); }
  for (const name of ['pointerup','pointercancel','lostpointercapture']) map.addEventListener(name,release);
  map.addEventListener('wheel',e=>{
    e.preventDefault(); const [x,y]=mapPoint(e);
    const distance=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?side:1);
    zoomAt(x,y,view.span*Math.exp(clamp(distance,-450,450)*.0018));
  },{passive:false});
  map.addEventListener('dblclick',resetMap);
  map.addEventListener('keydown',e=>{
    const step=view.span*(e.shiftKey ? .28 : .09);
    switch (e.key) {
      case 'Home': case 'Escape': resetMap(); break;
      case '+': case '=': zoomAt(side/2,side/2,view.span/1.35); break;
      case '-': case '_': zoomAt(side/2,side/2,view.span*1.35); break;
      case 'ArrowLeft': view.x-=step; break;
      case 'ArrowRight': view.x+=step; break;
      case 'ArrowUp': view.y+=step; break;
      case 'ArrowDown': view.y-=step; break;
      default: return;
    }
    e.preventDefault(); bounds(); invalidate();
  });

  const paintTime = t => { const s=Math.max(0,Math.floor(t+1e-6)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };
  const duration = () => Number.isFinite(audio.duration) && audio.duration>0 ? audio.duration : survey.seconds;
  let waveCache=null, pendingSeek=null;
  function traceWave(ctx,w,h) {
    const left=letter*.95, right=w-left, mid=(h-letter*1.37)/2;
    const radius=mid-2.6, data=survey.waveform, bars=Math.max(1,Math.min(data.length,Math.ceil((right-left)*1.6)));
    ctx.strokeStyle='#d5c3bf'; ctx.lineWidth=.5; ctx.beginPath(); ctx.moveTo(left,mid); ctx.lineTo(right,mid); ctx.stroke();
    ctx.beginPath();
    for (let j=0;j<bars;j++) {
      const first=Math.floor(j*data.length/bars), end=Math.floor((j+1)*data.length/bars);
      let lo=0, hi=0;
      for (let n=first;n<end;n++) { lo=Math.min(lo,data[n][0]); hi=Math.max(hi,data[n][1]); }
      const x=left+(j+.5)*(right-left)/bars;
      ctx.moveTo(x,mid-radius*hi/32768); ctx.lineTo(x,mid-radius*lo/32768);
    }
    ctx.lineWidth=Math.max(.55,(right-left)/bars); ctx.strokeStyle=red; ctx.stroke();
    const axisY=2*mid+.8;
    ctx.beginPath(); ctx.moveTo(left,axisY); ctx.lineTo(right,axisY); ctx.strokeStyle='#abaaa6'; ctx.lineWidth=.63; ctx.stroke();
    ctx.font=chartFont(); ctx.fillStyle=ink; ctx.textBaseline='top';
    for (const t of [0,15,30,45,60,75,85]) {
      const x=left+t/85*(right-left);
      ctx.beginPath(); ctx.moveTo(x,axisY); ctx.lineTo(x,axisY+2.8); ctx.stroke();
      ctx.textAlign=t===0?'left':t===85?'right':'center';
      if (t!==75 || w>270) ctx.fillText(paintTime(t),x,axisY+3.4);
    }
  }
  function drawWave() {
    const canvas=$('wave'); const {ctx,w,h}=context(canvas);
    if (!w || !h) return;
    const key=[canvas.width,canvas.height,letter,w,h].join('/');
    if (!waveCache || waveCache.key!==key) {
      const bg=document.createElement('canvas'); bg.width=canvas.width; bg.height=canvas.height;
      const pen=bg.getContext('2d'); pen.scale(bg.width/w,bg.height/h); traceWave(pen,w,h);
      waveCache={key,bg};
    }
    ctx.drawImage(waveCache.bg,0,0,w,h);
    const time = pendingSeek ?? audio.currentTime, total=duration();
    const inset=letter*.95, px=inset+clamp(time/total,0,1)*(w-2*inset);
    ctx.strokeStyle=ink; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(px,1); ctx.lineTo(px,h-letter*1.34); ctx.stroke();
    ctx.fillStyle=ink; ctx.beginPath(); ctx.moveTo(px-2.6,0); ctx.lineTo(px+2.6,0); ctx.lineTo(px,3.8); ctx.closePath(); ctx.fill();
    const display = paintTime(audio.ended ? Math.round(total) : time)+' / '+paintTime(Math.round(total));
    if ($('clock').textContent!==display) $('clock').textContent=display;
    seek.value=String(time); seek.setAttribute('aria-valuetext',paintTime(time)+' of '+paintTime(Math.round(total)));
  }
  function animateAudio() {
    audioFrame=0; drawWave();
    if (!audio.paused && !audio.ended && !document.hidden) audioFrame=requestAnimationFrame(animateAudio);
  }
  function syncPlayer() {
    const playing=!audio.paused && !audio.ended;
    $('play').toggleAttribute('data-playing',playing);
    $('play-label').textContent=playing?'Pause clip':audio.ended?'Replay clip':'Play clip';
    if (audioFrame) cancelAnimationFrame(audioFrame);
    animateAudio();
  }
  function showAudioError() { $('audio-error').hidden=false; syncPlayer(); }
  $('play').addEventListener('click',async()=>{
    if (!audio.paused && !audio.ended) { audio.pause(); return; }
    if (audio.ended) audio.currentTime=0;
    try { await audio.play(); $('audio-error').hidden=true; }
    catch (err) { if (err.name!=='AbortError') showAudioError(); }
  });
  function setTime(time) {
    time=clamp(time,0,duration());
    if (audio.readyState>=1) { pendingSeek=null; audio.currentTime=time; }
    else { pendingSeek=time; }
    drawWave();
  }
  seek.addEventListener('input',()=>setTime(Number(seek.value)));
  seek.addEventListener('keydown',e=>{
    const inc=e.shiftKey?10:1;
    const moves={ArrowLeft:-inc,ArrowDown:-inc,ArrowRight:inc,ArrowUp:inc,PageDown:-10,PageUp:10};
    let target=(pendingSeek ?? audio.currentTime)+(moves[e.key] ?? 0);
    if (e.key==='Home') target=0;
    else if (e.key==='End') target=duration();
    else if (!Object.hasOwn(moves,e.key)) return;
    e.preventDefault(); setTime(target);
  });
  function readDuration() {
    seek.max=String(duration());
    if (pendingSeek!==null && audio.readyState>=1) setTime(pendingSeek);
    drawWave();
  }
  for (const name of ['play','pause','ended']) audio.addEventListener(name,syncPlayer);
  for (const name of ['loadedmetadata','durationchange']) audio.addEventListener(name,readDuration);
  for (const name of ['timeupdate','seeked']) audio.addEventListener(name,drawWave);
  audio.addEventListener('error',showAudioError);
  document.addEventListener('visibilitychange',syncPlayer);
  function imageState() {
    if (orthoReady()) { $('map-status').hidden=true; invalidate(); }
    else { $('map-status').textContent='Orbital image unavailable'; $('map-status').hidden=false; }
  }
  ortho.addEventListener('load',imageState); ortho.addEventListener('error',imageState);
  if (ortho.complete) imageState();
  if (audio.error) showAudioError();
  window.addEventListener('resize',queueLayout); window.addEventListener('beforeprint',layout);
  window.addEventListener('afterprint',queueLayout);
  document.fonts.ready.then(()=>{ waveCache=null; queueLayout(); });
  layout();
})();
