// A square window into an undistorted 2:1 plate carrée raster, as in Day 1.
window.createSolarPlate = function (places, onSelect) {
  'use strict';
  const {rad, wrap, clamp, bodies, observer, eclipse} = window.Solar;
  const $ = id => document.getElementById(id);
  const map = $('map'), terrain = $('terrain'), linework = $('linework');
  const images = {earth:$('earth-image'), moon:$('moon-image')};
  const views = {earth:{lon:0, lat:0, zoom:1}, moon:{lon:0, lat:0, zoom:1}};
  const globeCache = {};
  const textures = Object.fromEntries(Object.entries(window.globeTextures).map(
    ([id, bytes]) => [id, Uint8Array.from(atob(bytes), c => c.charCodeAt(0))]));
  const shadeCanvas = document.createElement('canvas');
  const gridSteps = [.5, 1, 2, 5, 10, 15, 20, 30, 45, 60];
  let body = 'earth', suns, selection, size = 1, fontSize = 10, font = '';
  let needsBase = true, queued = false, hitLabels = [];
  const view = () => views[body];
  const span = () => 180 / view().zoom;
  const xOf = lon => size * (.5 + wrap(lon - view().lon)/span());
  const yOf = lat => size * (.5 - (lat - view().lat)/span());
  const lonAt = x => wrap(view().lon + (x / size - .5)*span());
  const latAt = y => clamp(view().lat + (.5 - y / size)*span(), -90, 90);
  const coordinate = (x, lat) => {
    const n = Math.abs(x);
    const suffix = n < .001 || (!lat && n > 179.999) ? '' : lat ? (x < 0 ? 'S' : 'N') : (x < 0 ? 'W' : 'E');
    return Number(n.toFixed(2)) + '°' + suffix;
  };

  function canvasContext(canvas, width = canvas.clientWidth, height = canvas.clientHeight) {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(width*dpr)), h = Math.max(1, Math.round(height*dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(w/Math.max(1,width), 0, 0, h/Math.max(1,height), 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = font;
    return ctx;
  }

  function normalize() {
    const v = view();
    v.zoom = clamp(v.zoom, 1, 12);
    v.lon = wrap(v.lon);
    v.lat = clamp(v.lat, -90 + span()/2, 90 - span()/2);
  }
  function invalidate(base = false) {
    needsBase ||= base;
    if (!queued) { queued = true; requestAnimationFrame(draw); }
  }
  function drawBase() {
    const photo = images[body], ctx = canvasContext(terrain);
    $('load-status').hidden = photo.naturalWidth > 0;
    if (!photo.naturalWidth) {
      $('load-status').textContent = photo.complete ? 'Terrain unavailable' : 'Loading terrain…';
      return;
    }
    const south = (90 - latAt(0))/180, height = span()/180;
    const left = (view().lon - span()/2 + 180)/360, right = left + span()/360;
    for (let tile = Math.floor(left); tile < Math.ceil(right); tile++) {
      const a = Math.max(left, tile), b = Math.min(right, tile+1);
      if (a >= b) continue;
      ctx.drawImage(photo, (a-tile)*photo.naturalWidth, south*photo.naturalHeight,
        (b-a)*photo.naturalWidth, height*photo.naturalHeight,
        (a-left)*size*360/span(), 0, (b-a)*size*360/span(), size);
    }
  }

  // For each latitude, solve the finite-distance horizon on the reference surface.
  function night(ctx, sun) {
    const slices = Math.max(240, Math.ceil(size));
    const {radius, eccentricity2} = bodies[body];
    const halfNight = new Float64Array(slices+1);
    const cosDecl = Math.hypot(sun.x,sun.y);
    for (let i=0; i<=slices; i++) {
      const lat = latAt(size*i/slices)*rad, s = Math.sin(lat);
      const surfaceUp = radius * Math.sqrt(1-eccentricity2*s*s);
      const cosHour = (surfaceUp/sun.range - s*sun.z) / (Math.cos(lat)*cosDecl);
      halfNight[i] = 180 - Math.acos(clamp(cosHour, -1, 1))/rad;
    }
    const center = xOf(sun.lon+180), px = size/span();
    ctx.beginPath();
    for (const offset of [-360,0,360]) {
      const cx = center + offset*px;
      if (cx+180*px < 0 || cx-180*px > size) continue;
      ctx.moveTo(cx-halfNight[0]*px, 0);
      for (let i=1; i<=slices; i++) ctx.lineTo(cx-halfNight[i]*px, size*i/slices);
      for (let i=slices; i>=0; i--) ctx.lineTo(cx+halfNight[i]*px, size*i/slices);
      ctx.closePath();
    }
    ctx.fillStyle = 'rgba(6,8,11,.72)';
    ctx.fill();
  }

  function eclipseShadow(ctx, sun) {
    if (!sun.blocker) return false;
    const n = Math.min(480, Math.max(192, Math.ceil(size)));
    shadeCanvas.width = shadeCanvas.height = n;
    const raster = shadeCanvas.getContext('2d');
    const pixels = raster.createImageData(n,n), levels = new Float32Array(n*n);
    let visible = false;
    for (let y=0; y<n; y++) {
      const lat = latAt((y+.5)*size/n);
      for (let x=0; x<n; x++) {
        const i = y*n+x;
        const p = observer(body, lonAt((x+.5)*size/n), lat);
        if (p.x*sun.x + p.y*sun.y + p.z*sun.z <= p.up/sun.range) continue;
        const cover = eclipse(body,sun,p);
        if (cover === 0) continue;
        visible = true; levels[i] = cover;
        pixels.data[4*i+3] = Math.round(234*Math.sqrt(cover));
      }
    }
    // Fine dashed outline just inside the penumbra, at one percent obscuration.
    for (let y=1; y<n-1; y++) {
      for (let x=1; x<n-1; x++) {
        const i = y*n+x;
        if (levels[i] < .01 || (x+y)%8 > 4) continue;
        if (Math.min(levels[i-1],levels[i+1],levels[i-n],levels[i+n]) >= .01) continue;
        pixels.data.set([152,59,53,215],4*i);
      }
    }
    raster.putImageData(pixels,0,0); ctx.drawImage(shadeCanvas,0,0,size,size);
    return visible;
  }

  // Parameterize an altitude circle in the Sun's local east/north basis. Unwrap
  // successive longitudes before clipping copies to the current map sheet.
  function altitudeLine(ctx, sun, level, labels) {
    const {radius} = bodies[body];
    const h = level*rad;
    const distance = Math.PI/2 - h - Math.asin(radius/sun.range*Math.cos(h));
    const c = Math.cos(distance), s = Math.sin(distance);
    const lon = sun.lon*rad, sl = Math.sin(lon), cl = Math.cos(lon);
    const cd = Math.hypot(sun.x,sun.y), n = Math.ceil(600*Math.sqrt(view().zoom));
    const line = new Path2D();
    let last = NaN, prevY = 0, candidate = null, best = Infinity;
    for (let i=0; i<=n; i++) {
      const angle = 2*Math.PI*i/n;
      const north = s*Math.cos(angle), east = s*Math.sin(angle);
      const lat = Math.asin(clamp(c*sun.z+north*cd,-1,1))/rad;
      const longitude = Math.atan2(c*sun.y - north*sun.z*sl + east*cl,
        c*sun.x - north*sun.z*cl - east*sl)/rad;
      const unwrapped = i === 0 ? view().lon + wrap(longitude-view().lon) : last + wrap(longitude-last);
      const y = yOf(lat);
      if (i > 0) {
        for (const shift of [-360,0,360]) {
          const x0 = size*(.5+(last+shift-view().lon)/span());
          const x1 = size*(.5+(unwrapped+shift-view().lon)/span());
          if (Math.max(x0,x1)<0 || Math.min(x0,x1)>size || Math.max(prevY,y)<0 || Math.min(prevY,y)>size) continue;
          line.moveTo(x0,prevY); line.lineTo(x1,y);
          // Keep contour lettering within the field and stagger it by elevation.
          if (x1<2.5*fontSize || x1>size-3.4*fontSize || y<2*fontSize || y>size-2*fontSize) continue;
          const score = Math.hypot(x1/size-(.62-level*.002), y/size-(.24+level*.003));
          if (score < best) { best=score; candidate={x:x1,y}; }
        }
      }
      last=unwrapped; prevY=y;
    }
    if (level === 0) {
      ctx.strokeStyle='rgba(255,248,237,.9)'; ctx.lineWidth=2.35; ctx.stroke(line);
      ctx.strokeStyle='#9b3d35'; ctx.lineWidth=1.12;
    } else {
      ctx.strokeStyle='rgba(255,255,255,.76)'; ctx.lineWidth=.75;
    }
    ctx.stroke(line);
    if (candidate) labels.push({...candidate,text:level+'°',kind:'altitude'});
  }

  function grid(ctx, isLat) {
    const axis = $(isLat ? 'latitude' : 'longitude'), ticks = canvasContext(axis);
    const d = span(), want = clamp(size*.122, 48, 112)*d/size;
    const step = gridSteps.reduce((a,b) => Math.abs(Math.log(a/want)) < Math.abs(Math.log(b/want)) ? a : b);
    const lo = isLat ? latAt(size) : view().lon - d/2;
    const hi = isLat ? latAt(0) : view().lon + d/2;
    const sub = step/5, edge = axis.clientWidth;
    ctx.beginPath(); ticks.beginPath(); ticks.textAlign='center'; ticks.fillStyle='#383835';
    for (let k=Math.ceil((lo-1e-7)/sub); k<=Math.floor((hi+1e-7)/sub); k++) {
      const v=k*sub, p=isLat ? yOf(v) : (v-lo)*size/d, major=k%5===0;
      if (major) {
        if (isLat) { ctx.moveTo(0,p); ctx.lineTo(size,p); }
        else { ctx.moveTo(p,0); ctx.lineTo(p,size); }
      }
      const length = major ? 4.2 : 2;
      if (isLat) { ticks.moveTo(edge-length,p); ticks.lineTo(edge,p); }
      else { ticks.moveTo(p,0); ticks.lineTo(p,length); }
      if (!major || p<fontSize*1.8 || p>size-fontSize*1.8) continue;
      ticks.save();
      if (isLat) { ticks.translate(edge-6,p); ticks.rotate(-Math.PI/2); ticks.textBaseline='bottom'; }
      else { ticks.translate(p,5); ticks.textBaseline='top'; }
      ticks.fillText(coordinate(isLat ? v : wrap(v),isLat),0,0); ticks.restore();
    }
    ctx.strokeStyle='rgba(255,255,255,.40)'; ctx.lineWidth=.5; ctx.stroke();
    ticks.strokeStyle='#696964'; ticks.lineWidth=.6; ticks.stroke();
  }

  function marker(ctx,x,y,selected) {
    ctx.beginPath(); ctx.arc(x,y,selected ? 3.6 : 1.65,0,2*Math.PI);
    ctx.fillStyle=selected ? '#a03c32' : '#f8f5ef'; ctx.fill();
    ctx.strokeStyle=selected ? '#fff6ee' : '#4a413a'; ctx.lineWidth=selected ? 1 : .7; ctx.stroke();
    if (selected) {
      ctx.beginPath();
      for (const sign of [-1,1]) {
        ctx.moveTo(x+sign*5,y); ctx.lineTo(x+sign*9,y);
        ctx.moveTo(x,y+sign*5); ctx.lineTo(x,y+sign*9);
      }
      ctx.strokeStyle='#f7ebdc'; ctx.lineWidth=1.5; ctx.stroke();
      ctx.strokeStyle='#983b35'; ctx.lineWidth=.7; ctx.stroke();
    }
  }

  function annotate(ctx, sun, contourLabels) {
    hitLabels = [];
    const occupied = [];
    const write = (text,x,y,site) => {
      const width=ctx.measureText(text).width, h=fontSize*1.18;
      const left=clamp(x,3,Math.max(3,size-width-3)), top=clamp(y,2,size-h-2);
      const box={x:left-2,y:top-1,w:width+4,h:h+2};
      if (occupied.some(b=>box.x<b.x+b.w && box.x+box.w>b.x && box.y<b.y+b.h && box.y+box.h>b.y)) return;
      occupied.push(box); if (site) hitLabels.push({...box,site});
      ctx.lineJoin='round'; ctx.lineWidth=2.3; ctx.strokeStyle='rgba(25,27,27,.78)';
      ctx.textBaseline='top'; ctx.strokeText(text,left,top); ctx.fillStyle='#fff'; ctx.fillText(text,left,top);
    };
    for (const site of [selection,...places[body].filter(s=>s!==selection)]) {
      const x=xOf(site.lon), y=yOf(site.lat);
      if (x<0 || y<0 || x>size || y>size) continue;
      marker(ctx,x,y,site===selection);
      const pad=site===selection ? 7 : 4;
      const name=site.name;
      const width=ctx.measureText(name).width;
      write(name,x+pad+width>size-3 ? x-width-pad : x+pad,y-fontSize-2,site);
    }
    const x=xOf(sun.lon), y=yOf(sun.lat);
    if (x>0 && y>0 && x<size && y<size) {
      ctx.beginPath(); ctx.arc(x,y,4.2,0,2*Math.PI); ctx.moveTo(x-6.6,y); ctx.lineTo(x+6.6,y);
      ctx.moveTo(x,y-6.6); ctx.lineTo(x,y+6.6);
      ctx.strokeStyle='#fff5e9'; ctx.lineWidth=2.2; ctx.stroke();
      ctx.strokeStyle='#873931'; ctx.lineWidth=.95; ctx.stroke();
      write('Subsolar point',x+8,y-fontSize/2);
    }
    for (const label of contourLabels) write(label.text,label.x+2,label.y-fontSize-1);
  }

  function drawGlobe(id, sun) {
    const canvas=$(id+'-globe'), cssWidth=canvas.clientWidth;
    if (!cssWidth) return;
    const n=Math.round(cssWidth*Math.min(window.devicePixelRatio || 1, 3));
    canvas.width=canvas.height=n;
    const ctx=canvas.getContext('2d'), data=ctx.createImageData(n,n), v=views[id];
    const key=[n,v.lon,v.lat].join('/');
    let cache=globeCache[id];
    if (cache?.key!==key) {
      const points=[], sl=Math.sin(v.lon*rad), cl=Math.cos(v.lon*rad);
      const sp=Math.sin(v.lat*rad), cp=Math.cos(v.lat*rad);
      for (let y=0; y<n; y++) for (let x=0; x<n; x++) {
        const e=(2*x+1)/n-1, north=1-(2*y+1)/n, r2=e*e+north*north;
        if (r2>=1) continue;
        const front=Math.sqrt(1-r2), z=sp*front+cp*north;
        const nx=cl*(cp*front-sp*north)-sl*e, ny=sl*(cp*front-sp*north)+cl*e;
        const lat=Math.asin(clamp(z,-1,1))/rad, lon=Math.atan2(ny,nx)/rad;
        const col=Math.floor((lon+180)%360), row=clamp(Math.floor(90-lat),0,179);
        const gray=textures[id][row*360+col], a=clamp((1-Math.sqrt(r2))*n/2,0,1);
        points.push({i:4*(y*n+x), nx,ny,z,lat,lon,gray,a});
      }
      cache=globeCache[id]={key,points};
    }
    for (const p of cache.points) {
      const dot=p.nx*sun.x+p.ny*sun.y+p.z*sun.z;
      const threshold=bodies[id].radius/sun.range;
      let light=clamp(.5+(dot-threshold)*n*.56,0,1);
      if (light>0 && sun.blocker) light*=1-eclipse(id,sun,observer(id,p.lon,p.lat));
      const gray=clamp((p.gray+9)*(.25+.75*light),0,255);
      data.data[p.i]=data.data[p.i+1]=data.data[p.i+2]=gray;
      data.data[p.i+3]=255*p.a;
    }
    ctx.putImageData(data,0,0);
    ctx.beginPath(); ctx.arc(n/2,n/2,n/2-.5,0,2*Math.PI);
    ctx.strokeStyle='rgba(58,54,50,.65)'; ctx.lineWidth=.65*n/cssWidth; ctx.stroke();
  }

  function draw() {
    queued=false;
    if (!suns || !selection || !map.clientWidth) return;
    if (needsBase) { drawBase(); needsBase=false; }
    const ctx=canvasContext(linework), sun=suns[body], labels=[];
    night(ctx,sun);
    const eclipsed=eclipseShadow(ctx,sun);
    document.querySelector('.eclipse-key').hidden=!eclipsed;
    grid(ctx,false); grid(ctx,true);
    for (const altitude of [15,30,45,60,75,0]) altitudeLine(ctx,sun,altitude,labels);
    annotate(ctx,sun,labels);
    for (const id of ['earth','moon']) drawGlobe(id,suns[id]);
  }

  const pointers = new Map();
  let gesture=null;
  function point(event) {
    const rect=map.getBoundingClientRect();
    return {x:event.clientX-rect.left,y:event.clientY-rect.top};
  }
  const distance=(a,b) => Math.hypot(a.x-b.x,a.y-b.y);
  const midpoint=(a,b) => b ? {x:(a.x+b.x)/2,y:(a.y+b.y)/2} : a;
  function beginGesture(canPick) {
    const [a,b]=pointers.values();
    if (!a) {gesture=null; return;}
    const mid=midpoint(a,b);
    gesture={mid,lon:lonAt(mid.x),lat:latAt(mid.y),zoom:view().zoom,
      separation:b ? Math.max(1,distance(a,b)) : 1,pick:canPick&&!b};
  }
  function anchor(lon,lat,p,zoom) {
    view().zoom=clamp(zoom,1,12);
    view().lon=lon-(p.x/size-.5)*span(); view().lat=lat+(p.y/size-.5)*span();
    normalize(); invalidate(true);
  }
  function pick(p) {
    const label=hitLabels.find(b=>p.x>=b.x && p.x<=b.x+b.w && p.y>=b.y && p.y<=b.y+b.h);
    const nearby=places[body].find(s=>Math.hypot(xOf(s.lon)-p.x,yOf(s.lat)-p.y)<=6);
    onSelect(label?.site || nearby || {name:'Map point',lon:lonAt(p.x),lat:latAt(p.y)});
  }
  map.addEventListener('pointerdown',e=>{
    if (e.button!==0) return;
    map.setPointerCapture(e.pointerId); pointers.set(e.pointerId,point(e));
    beginGesture(pointers.size===1); map.classList.add('dragging');
  });
  map.addEventListener('pointermove',e=>{
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId,point(e));
    const [a,b]=pointers.values(), p=midpoint(a,b);
    if (gesture.pick && distance(p,gesture.mid)<4 && !b) return;
    gesture.pick=false;
    anchor(gesture.lon,gesture.lat,p,gesture.zoom*(b ? distance(a,b)/gesture.separation : 1));
  });
  function release(e,allowPick) {
    if (!pointers.has(e.pointerId)) return;
    const tap=allowPick && gesture?.pick;
    pointers.delete(e.pointerId); beginGesture(false);
    map.classList.toggle('dragging',pointers.size>0);
    if (tap) pick(point(e));
  }
  map.addEventListener('pointerup',e=>release(e,true));
  map.addEventListener('pointercancel',e=>release(e,false));
  map.addEventListener('lostpointercapture',e=>release(e,false));
  map.addEventListener('wheel',e=>{
    e.preventDefault();
    const p=point(e), delta=e.deltaY*(e.deltaMode===1 ? 16 : e.deltaMode===2 ? size : 1);
    anchor(lonAt(p.x),latAt(p.y),p,view().zoom*Math.exp(-clamp(delta*(e.ctrlKey ? .009 : .0025),-.72,.72)));
  },{passive:false});
  map.addEventListener('keydown',e=>{
    const v=view(), step=(e.shiftKey ? .28 : .08)*span();
    switch(e.key) {
      case 'ArrowLeft': v.lon-=step; break;
      case 'ArrowRight': v.lon+=step; break;
      case 'ArrowUp': v.lat+=step; break;
      case 'ArrowDown': v.lat-=step; break;
      case '+': case '=': v.zoom*=1.5; break;
      case '-': case '_': v.zoom/=1.5; break;
      case 'Home': Object.assign(v,{lon:0,lat:0,zoom:1}); break;
      case 'Enter': onSelect({name:'Map point',lon:v.lon,lat:v.lat}); break;
      default: return;
    }
    e.preventDefault(); normalize(); invalidate(true);
  });
  for (const image of Object.values(images)) {
    image.addEventListener('load',()=>invalidate(true)); image.addEventListener('error',()=>invalidate(true));
  }
  return {
    update(id,directions,site) {
      const changed=id!==body; body=id; suns=directions; selection=site;
      map.setAttribute('aria-label',(id==='earth' ? 'Earth' : 'Moon')+' illumination map');
      invalidate(changed);
    },
    locate(site) {
      if (xOf(site.lon)<size*.08 || xOf(site.lon)>size*.92 || yOf(site.lat)<size*.04 || yOf(site.lat)>size*.96) {
        view().lon=site.lon; view().lat=site.lat; normalize(); invalidate(true);
      }
    },
    resize() {
      const style=getComputedStyle(document.body);
      font=style.fontWeight+' '+style.fontSize+' '+style.fontFamily; fontSize=parseFloat(style.fontSize);
      size=map.clientWidth || 1; normalize(); invalidate(true);
    }
  };
};
