(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const map = $('map');
  const terrain = $('terrain');
  const linework = $('linework');
  const base = terrain.getContext('2d', {alpha: false});
  const overlay = linework.getContext('2d');
  const DEG = Math.PI / 180;
  const KM = 1737.4 * DEG;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const features = window.LUNAR_PLACES;
  const byName = new Map(features.map(place => [place[0], place]));
  const leadingFeatures = ['Tycho', 'Copernicus', 'Tsiolkovskiy', 'Pictet', 'Street', 'Proctor', 'Clavius'];
  const registerRows = new Map();
  let selectedPlace = null;
  let chartFont, letterSize;
  const regionalMaps = [
    {name:'tycho', path:'tycho', box:[-24,-53,2,-34], preview:'tycho-preview.webp'},
    {name:'copernicus', path:'regions/copernicus', box:[-28,3,-12,15]},
    {name:'tsiolkovskiy', path:'regions/tsiolkovskiy', box:[121,-27,137,-14]}
  ];
  let W = 0, H = 0, dpr = 1;
  let center = {lon:-9.6, lat:-43.6, km:0.28};
  let dirty = false, motion = null, geometry;
  const imageCache = new Map();
  const labelNodes = new Map();
  const pointers = new Map();
  let gesture = null, wheelTarget = null;
  const minKm = 0.105;
  const maxKm = () => KM * Math.min(167 / H, 345 / W);

  function coordinate(value, latitude, decimals = 0) {
    const v = latitude ? value : wrap(value);
    const rounded = Number(Math.abs(v).toFixed(decimals));
    const suffix = rounded < 1e-7 || (!latitude && rounded === 180) ? '' : latitude ? (v > 0 ? 'N' : 'S') : (v > 0 ? 'E' : 'W');
    return Math.abs(v).toFixed(decimals) + '°' + suffix;
  }
  function initialView() {
    return {lon:-9.62, lat:-44.48, km:216/W};
  }
  function projection() {
    center.km = clamp(center.km, minKm, maxKm());
    const sy = KM / center.km;
    const half = H / (2 * sy);
    center.lat = clamp(center.lat, -90 + half, 90 - half);
    center.lon = wrap(center.lon);
    const cosLat = Math.cos(center.lat * DEG);
    const sx = Math.max(W / 360, sy * cosLat);
    return {sx, sy, west:center.lon - W/(2*sx), east:center.lon + W/(2*sx),
      north:center.lat + half, south:center.lat - half, kmX:KM * cosLat / sx};
  }
  function sizeCanvas(canvas, w, h) {
    const pw = Math.round(w*dpr), ph = Math.round(h*dpr);
    if (canvas.width !== pw || canvas.height !== ph) {canvas.width = pw; canvas.height = ph;}
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  function invalidate() {
    if (!dirty) {dirty = true; requestAnimationFrame(render);}
  }
  function asset(path) {
    let entry = imageCache.get(path);
    if (!entry) {
      const img = new Image();
      entry = {img, loaded:false, lastUse:performance.now()};
      imageCache.set(path, entry);
      img.onload = () => {entry.loaded = true; invalidate();};
      img.onerror = () => {entry.failed = true; invalidate();};
      img.src = 'assets/' + path;
    }
    entry.lastUse = performance.now();
    return entry.loaded ? entry.img : null;
  }
  function trimCache() {
    const tiles = [...imageCache.entries()].filter(([name, e]) => name.startsWith('tiles/') && e.loaded);
    if (tiles.length <= 16) return;
    tiles.sort((a,b) => a[1].lastUse-b[1].lastUse);
    tiles.slice(0,tiles.length-16).forEach(([name,e]) => {if (performance.now()-e.lastUse>3000) imageCache.delete(name);});
  }
  // For each visible copy, crop in source pixels before drawing. This keeps even
  // the global overview within the browser's maximum destination bitmap size.
  function patches(box, view) {
    const [west,south,east,north] = box;
    if (north <= view.south || south >= view.north) return [];
    const result=[];
    const first=Math.ceil((view.west-east)/360), last=Math.floor((view.east-west)/360);
    for (let turn=first; turn<=last; turn++) {
      const left=west+turn*360, right=east+turn*360;
      const l=Math.max(left, view.west), r=Math.min(right, view.east);
      const b=Math.max(south,view.south), t=Math.min(north,view.north);
      if (r-l < 1e-8 || t-b < 1e-8) continue;
      result.push([(l-left)/(east-west), (north-t)/(north-south), (r-l)/(east-west), (t-b)/(north-south),
        (l-view.west)*view.sx,(view.north-t)*view.sy,(r-l)*view.sx,(t-b)*view.sy]);
    }
    return result;
  }
  function blit(image, visible, alpha=1) {
    if (!image) return;
    base.globalAlpha=alpha;
    for (const p of visible) {
      const [u,v,du,dv,x,y,w,h]=p;
      base.drawImage(image,u*image.width,v*image.height,du*image.width,dv*image.height,x,y,w,h);
    }
    base.globalAlpha=1;
  }
  // Keep regional isolines as geographic paths so their stroke width stays
  // constant through zooms. The classic script loader also works from file://.
  const vectorRegions=new Map(), vectorPending=new Set();
  let heightMarks=[];
  window.acceptLunarContours=(name,payload)=>{
    const bytes=Uint8Array.from(atob(payload),c=>c.charCodeAt(0));
    const data=new DataView(bytes.buffer);
    const groups=new Map(), marks=[];
    for(let off=0;off<data.byteLength;){
      const elevation=data.getInt16(off,true), n=data.getUint16(off+2,true);
      const start=off+4;off=start+n*4;
      const path=new Path2D();
      let minX=65535,minY=65535,maxX=0,maxY=0;
      const major=elevation%1000===0;
      for(let i=0;i<n;i++){
        const x=data.getUint16(start+i*4,true),y=data.getUint16(start+i*4+2,true);
        if(i===0)path.moveTo(x,y);else path.lineTo(x,y);
        minX=Math.min(x,minX);maxX=Math.max(x,maxX);minY=Math.min(y,minY);maxY=Math.max(y,maxY);
      }
      const key=[major,Math.floor((minX+maxX)/16384),Math.floor((minY+maxY)/16384)].join('/');
      if(!groups.has(key))groups.set(key,{path:new Path2D(),major,bounds:[minX,minY,maxX,maxY]});
      const group=groups.get(key), bounds=group.bounds;
      group.path.addPath(path);
      bounds[0]=Math.min(bounds[0],minX);bounds[1]=Math.min(bounds[1],minY);
      bounds[2]=Math.max(bounds[2],maxX);bounds[3]=Math.max(bounds[3],maxY);
      if(major && n>38) {
        const index=Math.floor(n*.43);
        const point=j=>[data.getUint16(start+j*4,true),data.getUint16(start+j*4+2,true)];
        const [x,y]=point(index), a=point(index-2), b=point(index+2);
        marks.push({x,y,dx:b[0]-a[0],dy:b[1]-a[1],elevation,span:Math.hypot(maxX-minX,maxY-minY)});
      }
    }
    vectorRegions.set(name,{groups:[...groups.values()],marks:marks.sort((a,b)=>b.span-a.span)});
    invalidate();
  };
  function drawRegionalLines(region,g) {
    if(!vectorPending.has(region.name)){
      vectorPending.add(region.name);
      const script=document.createElement('script');
      script.src='assets/regions/'+region.name+'-lines.js';
      script.onload=()=>script.remove();
      script.onerror=()=>script.remove();
      document.head.append(script);
    }
    const lines=vectorRegions.get(region.name);
    if(!lines){blit(asset(region.path+'-contours.png'),region.visible,.72);return;}
    const [w,s,e,n]=region.box;
    const xs=(e-w)*g.sx/65535, ys=(n-s)*g.sy/65535;
    for(const [u,v,du,dv,x,y,pw,ph] of region.visible){
      const x0=x-u*65535*xs, y0=y-v*65535*ys;
      const screen=[u*65535,v*65535,(u+du)*65535,(v+dv)*65535];
      base.save();base.beginPath();base.rect(x,y,pw,ph);base.clip();
      base.translate(x0,y0);base.scale(xs,ys);base.lineCap='round';base.lineJoin='round';
      for(const group of lines.groups){
        if(!overlap(group.bounds,screen))continue;
        base.lineWidth=(group.major?1.02:.66)/Math.sqrt(xs*ys);
        base.strokeStyle=group.major?'rgba(255,255,250,.83)':'rgba(255,255,250,.68)';
        base.stroke(group.path);
      }
      base.restore();
      for(const mark of lines.marks){
        const sx=x0+mark.x*xs,sy=y0+mark.y*ys;
        if(sx<40||sx>W-40||sy<40||sy>H-50||mark.span*Math.min(xs,ys)<70)continue;
        let angle=Math.atan2(mark.dy*ys,mark.dx*xs);
        if(angle>Math.PI/2)angle-=Math.PI;
        if(angle< -Math.PI/2)angle+=Math.PI;
        if(Math.abs(angle)<.64)heightMarks.push({x:sx,y:sy,angle,elevation:mark.elevation});
      }
    }
  }
  function drawElevations(obstacles) {
    const used=new Set();
    for(const m of heightMarks){
      const box=[m.x-37,m.y-12,m.x+37,m.y+12];
      if(used.has(m.elevation)||obstacles.some(b=>overlap(b,box)))continue;
      const text=(m.elevation<0?'−':'')+Math.abs(m.elevation)+' m';
      overlay.save();overlay.translate(m.x,m.y);overlay.rotate(m.angle);
      overlay.font=chartFont;overlay.textAlign='center';overlay.textBaseline='middle';
      overlay.lineJoin='round';overlay.lineWidth=3.6;overlay.strokeStyle='rgba(48,48,45,.69)';overlay.strokeText(text,0,0);
      overlay.fillStyle='#fffef8';overlay.fillText(text,0,0);overlay.restore();
      used.add(m.elevation);obstacles.push([m.x-125,m.y-70,m.x+125,m.y+70]);
      if(used.size>=(W<650?1:3))break;
    }
  }
  function paintTerrain(g) {
    heightMarks=[];
    base.fillStyle='#595955'; base.fillRect(0,0,W,H);
    const worldPatches = patches([-180,-90,180,90],g);
    const local = regionalMaps.map(r => ({...r, visible:patches(r.box,g)}))
      .filter(r => r.visible.length && g.sy>24);
    // A complete regional sheet can be viewed without decoding the global raster.
    let fullRegion = local.find(r => r.visible.some(p => p[6]>=W-.01 && p[7]>=H-.01));
    const readyLocal = r => (r.preview && asset(r.preview)) || asset(r.path+'.webp');
    const skipBase = fullRegion && readyLocal(fullRegion);
    const detailed = g.sy>24;
    let painted=false;
    const intervals=new Set();
    if (!skipBase) {
      const world=asset('global.webp');
      if (world) {
        blit(world,worldPatches);painted=true;
        if (!detailed) blit(asset('global-contours.png'),worldPatches,.83);
      }
      if (!detailed) intervals.add(2000);
      if (detailed) {
        for (let row=0;row<4;row++) {
          const north=90-row*45;
          if(north<g.south || north-45>g.north) continue;
          for (let col=0;col<8;col++) {
            const west=-180+col*45;
            const visible=patches([west,north-45,west+45,north],g);
            if (!visible.length) continue;
            const path='tiles/'+row+'-'+col;
            const tile=asset(path+'.webp');
            if (!tile) continue;
            blit(tile,visible);painted=true;
            blit(asset(path+'-contours.png'),visible,.82);
          }
        }
        intervals.add(500);
      }
    }
    for (const region of local) {
      const preview=region.preview ? asset(region.preview) : null;
      const high=asset(region.path+'.webp') || preview;
      if (!high) continue;
      blit(high,region.visible);painted=true;
      drawRegionalLines(region,g);
      intervals.add(500);
    }
    const displayedInterval = intervals.has(500) || skipBase ? 500 : 2000;
    $('interval').textContent = displayedInterval.toLocaleString('en-US')+' metres';
    const status=$('load-status');
    status.hidden=painted;
    if (!painted && imageCache.get('global.webp')?.failed) status.textContent='Terrain unavailable · reopen with the assets folder beside this file';
    trimCache();
  }
  const choices=[.05,.1,.2,.25,.5,1,2,5,10,15,20,30,45,60,90];
  const nearestStep=n=>choices.reduce((a,b)=>Math.abs(Math.log(a/n))<Math.abs(Math.log(b/n))?a:b);
  // The axes and terrain grid use the same projected ticks. Numeric labels are
  // painted onto separate paper canvases outside the square image.
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
      const label = coordinate(value, isLatitude, 2);
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
  function registration(g) {
    const spacing = clamp(W / 3.7, 90, 235);
    const xs = drawAxis(false, nearestStep(spacing / g.sx), g);
    const ys = drawAxis(true, nearestStep(spacing / g.sy), g);
    overlay.beginPath();
    for (const x of xs) {overlay.moveTo(x, 0); overlay.lineTo(x, H);}
    for (const y of ys) {overlay.moveTo(0, y); overlay.lineTo(W, y);}
    overlay.lineWidth = 1.35;
    overlay.strokeStyle = 'rgba(32,32,32,.2)';
    overlay.stroke();
    overlay.lineWidth = .8;
    overlay.strokeStyle = 'rgba(255,255,255,.82)';
    overlay.stroke();
    overlay.beginPath();
    for (const x of xs) for (const y of ys) {
      overlay.moveTo(x - 2, y - 3);
      overlay.lineTo(x + 2, y + 3);
    }
    overlay.lineWidth = 2;
    overlay.strokeStyle = '#fff';
    overlay.stroke();
  }
  function mapPoint(lon,lat,g) {
    return [W/2+wrap(lon-center.lon)*g.sx,H/2+(center.lat-lat)*g.sy];
  }
  const overlap=(a,b)=>a[0]<b[2]&&a[2]>b[0]&&a[1]<b[3]&&a[3]>b[1];
  function visitPlace(place) {
    selectPlace(place);
    const polarLimit = 2 * KM * (90 - Math.abs(place[2])) / H;
    const detail = Math.min(place[3] / (W * .48), polarLimit);
    flyTo({lon:place[1], lat:place[2], km:detail});
    map.focus({preventScroll:true});
  }
  function selectPlace(place) {
    if (selectedPlace) registerRows.get(selectedPlace[5]).removeAttribute('aria-current');
    selectedPlace = place;
    if (place) registerRows.get(place[5]).setAttribute('aria-current', 'true');
  }
  function buildRegister() {
    const first = leadingFeatures.map(name => byName.get(name));
    const alphabetical = features.filter(place => !leadingFeatures.includes(place[0]));
    const collator = new Intl.Collator('en');
    alphabetical.sort((a, b) => collator.compare(a[0], b[0]));
    const rows = $('feature-rows');
    const fragment = document.createDocumentFragment();
    for (const place of [...first, ...alphabetical]) {
      const row = document.createElement('tr');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = place[0];
      button.setAttribute('aria-label', 'Fly to ' + place[0]);
      row.insertCell().append(button);
      row.insertCell().textContent = coordinate(place[2], true, 2);
      row.insertCell().textContent = coordinate(place[1], false, 2);
      row.dataset.name = place[0];
      registerRows.set(place[5], row);
      fragment.append(row);
    }
    rows.append(fragment);
    rows.addEventListener('click', event => {
      const row = event.target.closest('tr');
      if (row) visitPlace(byName.get(row.dataset.name));
    });
  }
  function drawLabels(g) {
    const retained = new Set(), occupied = [];
    overlay.font = chartFont;
    const ordered = selectedPlace ? [selectedPlace, ...features] : features;
    for (const place of ordered) {
      if (retained.has(place[5])) continue;
      if (retained.size >= 4) break;
      const diameter = place[3] / center.km;
      if (diameter < Math.max(22, W * .075) || diameter > W * 2.2) continue;
      const [x, y] = mapPoint(place[1], place[2], g);
      if (x < 7 || x > W - 7 || y < 14 || y > H - 14) continue;
      const width = overlay.measureText(place[0]).width + 4;
      const right = x + 15 + width < W - 4;
      const end = x + (right ? 13 : -13);
      const left = right ? end + 2 : end - 2 - width;
      if (left < 3 || left + width > W - 3) continue;
      const box = [Math.min(x - 4, left), y - 13, Math.max(x + 4, left + width), y + 13];
      if (occupied.some(b => overlap(b, box))) continue;
      occupied.push([box[0] - 8, box[1] - 5, box[2] + 8, box[3] + 5]);
      const direction = right ? 1 : -1;
      overlay.beginPath();
      overlay.moveTo(x, y); overlay.lineTo(x + 5 * direction, y - 5); overlay.lineTo(end, y - 5);
      overlay.lineWidth = 1.7; overlay.strokeStyle = 'rgba(35,35,35,.45)'; overlay.stroke();
      overlay.lineWidth = .85; overlay.strokeStyle = '#fff'; overlay.stroke();
      overlay.fillStyle = '#fff'; overlay.fillRect(x - 1.5, y - 1.5, 3, 3);
      let node = labelNodes.get(place[5]);
      if (!node) {
        node = document.createElement('button');
        node.type = 'button';
        node.textContent = place[0];
        node.setAttribute('aria-label', 'Fly to ' + place[0]);
        // Keyboard and assistive activation. Pointer taps are resolved after
        // release, so a drag can start over a name without triggering a flight.
        node.addEventListener('click', e => {if (e.detail === 0) visitPlace(place);});
        node.className = 'feature-label';
        $('map-labels').append(node);
        labelNodes.set(place[5], node);
      }
      node.style.transform = 'translate(' + left + 'px,' + (y - 9 - letterSize * .635) + 'px)';
      retained.add(place[5]);
    }
    for (const [id, node] of labelNodes) {
      if (!retained.has(id)) {node.remove(); labelNodes.delete(id);}
    }
    return occupied;
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
  function hemispheres(g) {
    for(const [id,meridian] of [['near-side',0],['far-side',180]]) {
      const c=$(id).querySelector('canvas'), d=c.clientWidth, r=d/2;
      const ctx=sizeCanvas(c,d,d);ctx.clearRect(0,0,d,d);
      const project=(lon,lat)=>[r+r*Math.cos(lat*DEG)*Math.sin((lon-meridian)*DEG),r-r*Math.sin(lat*DEG)];
      function edge(x1,y1,x2,y2,start=false) {
        const steps=Math.max(1,Math.ceil(Math.max(Math.abs(x1-x2),Math.abs(y1-y2))/4));
        for(let j=0;j<=steps;j++){
          const t=j/steps, [x,y]=project(x1+t*(x2-x1),y1+t*(y2-y1));
          if(start&&j===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
        }
      }
      ctx.lineWidth=.45;ctx.strokeStyle='rgba(255,255,248,.5)';
      ctx.beginPath();
      for(const l of [-60,0,60])edge(meridian+l,-90,meridian+l,90,true);
      for(const b of [-45,0,45])edge(meridian-90,b,meridian+90,b,true);
      ctx.stroke();
      for(let turn=-1;turn<=1;turn++) {
        const m=meridian+360*turn;
        const l=Math.max(g.west,m-90),e=Math.min(g.east,m+90);
        if(l>=e)continue;
        ctx.beginPath();edge(l,g.north,e,g.north,true);edge(e,g.north,e,g.south);edge(e,g.south,l,g.south);edge(l,g.south,l,g.north);ctx.closePath();
        ctx.fillStyle='rgba(211,52,29,.26)';ctx.fill();
        ctx.lineWidth=2.6;ctx.strokeStyle='rgba(255,250,235,.83)';ctx.stroke();
        ctx.lineWidth=1.45;ctx.strokeStyle='#be3727';ctx.stroke();
      }
    }
  }
  function readout() {
    $('position').textContent=coordinate(center.lat,true,2)+'  /  '+coordinate(center.lon,false,2);
  }
  function render(now) {
    dirty=false;
    if(motion)motion(now);
    geometry=projection();
    base.setTransform(dpr,0,0,dpr,0,0);
    overlay.setTransform(dpr,0,0,dpr,0,0);overlay.clearRect(0,0,W,H);
    paintTerrain(geometry);
    registration(geometry);
    drawElevations(drawLabels(geometry));
    drawScale(geometry);hemispheres(geometry);readout();
    if(motion)invalidate();
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
    const type = getComputedStyle(document.body);
    letterSize = parseFloat(type.fontSize);
    chartFont = type.fontWeight + ' ' + type.fontSize + ' ' + type.fontFamily;
    const w=map.clientWidth,h=map.clientHeight;
    if(!w||!h)return;
    const previousWidth=W;
    W=w;H=h;dpr=Math.min(window.devicePixelRatio||1,2);
    sizeCanvas(terrain,W,H);sizeCanvas(linework,W,H);
    if(previousWidth)center.km*=previousWidth/W;
    else center=initialView();
    invalidate();
  }
  function stop() {motion=null;wheelTarget=null;}
  function animate(duration,callback,done) {
    const start=performance.now();
    if(reduced.matches){callback(1);if(done)done();invalidate();return;}
    motion=now=>{
      const t=clamp((now-start)/duration,0,1);callback(t);
      if(t>=1){motion=null;if(done)done();}
    };
    invalidate();
  }
  const smooth=t=>t*t*(3-2*t);
  function flyTo(target) {
    stop();
    const from={...center}, dl=wrap(target.lon-from.lon), db=target.lat-from.lat;
    const distance=Math.hypot(dl*Math.cos((from.lat+target.lat)*.5*DEG),db);
    const length=distance*KM/Math.max(W,H);
    const dest=clamp(target.km,minKm,maxKm());
    const crest=clamp(Math.max(from.km,dest,length*.75),minKm,maxKm());
    animate(clamp(420+distance*5,460,1150),t=>{
      const k=smooth(t);
      center.lon=from.lon+dl*k;center.lat=from.lat+db*k;
      const linear=(1-k)*Math.log(from.km)+k*Math.log(dest);
      const rise=Math.log(crest)-.5*(Math.log(from.km)+Math.log(dest));
      center.km=Math.exp(linear+Math.sin(Math.PI*t)**2*Math.max(0,rise));
    });
  }
  function goHome() {selectPlace(null);flyTo(initialView());}
  function geoAt(x,y) {
    const g=projection();return {lon:g.west+x/g.sx,lat:g.north-y/g.sy};
  }
  function setAnchor(anchor,x,y,km) {
    center.km=clamp(km,minKm,maxKm());
    const sy=KM/center.km;
    center.lat=anchor.lat+(y-H/2)/sy;
    const g=projection();
    center.lon=wrap(anchor.lon-(x-W/2)/g.sx);
  }
  function zoom(factor,x=W/2,y=H/2,wheel=false) {
    const dest=clamp((wheel&&wheelTarget?wheelTarget:center.km)*factor,minKm,maxKm());
    stop();
    if(wheel)wheelTarget=dest;
    const anchor=geoAt(x,y), log=Math.log(center.km), change=Math.log(dest)-log;
    animate(wheel?145:245,t=>{
      setAnchor(anchor,x,y,Math.exp(log+change*(1-(1-t)**3)));
    },()=>{wheelTarget=null;});
  }
  function localPoint(e) {const rect=map.getBoundingClientRect();return {x:e.clientX-rect.left,y:e.clientY-rect.top};}
  const midpoint=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  let lastTap=null;
  function beginGesture() {
    const [a,b]=[...pointers.values()];
    if(!a){gesture=null;return;}
    if(b) {
      const mid=midpoint(a,b);
      gesture={type:'pinch',anchor:geoAt(mid.x,mid.y),span:Math.max(1,distance(a,b)),km:center.km};
    }else{
      gesture={type:'pan',anchor:geoAt(a.x,a.y),start:a,last:a,lastTime:performance.now(),vx:0,vy:0};
    }
  }
  map.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;
    map.focus({preventScroll:true});stop();
    map.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId,localPoint(e));beginGesture();
    const label = e.target.closest('.feature-label');
    if (label && gesture.type === 'pan') gesture.place = byName.get(label.textContent);
    if(pointers.size>1)lastTap=null;
    map.classList.add('dragging');
  });
  map.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId)||!gesture)return;
    const pt=localPoint(e),now=performance.now();pointers.set(e.pointerId,pt);
    if(gesture.type==='pinch'){
      const [a,b]=[...pointers.values()],mid=midpoint(a,b);
      setAnchor(gesture.anchor,mid.x,mid.y,gesture.km*gesture.span/Math.max(1,distance(a,b)));
    }else{
      setAnchor(gesture.anchor,pt.x,pt.y,center.km);
      const dt=Math.max(5,now-gesture.lastTime);
      const weight=1-Math.exp(-dt/25);
      gesture.vx+=(clamp((pt.x-gesture.last.x)/dt,-3,3)-gesture.vx)*weight;
      gesture.vy+=(clamp((pt.y-gesture.last.y)/dt,-3,3)-gesture.vy)*weight;
      gesture.last=pt;gesture.lastTime=now;
    }
    invalidate();
  });
  function endPointer(e) {
    if(!pointers.has(e.pointerId))return;
    const g=gesture, pt=pointers.get(e.pointerId), now=performance.now();
    pointers.delete(e.pointerId);
    if(pointers.size){beginGesture();if(gesture)gesture.continued=true;return;}
    map.classList.remove('dragging');gesture=null;
    if(e.type!=='pointerup'||!g||g.type!=='pan')return;
    if(g.place && !g.continued && distance(g.start,pt)<5) {
      lastTap=null; visitPlace(g.place); return;
    }
    if(distance(g.start,pt)<5 && !g.continued && e.pointerType==='touch') {
      if(lastTap && now-lastTap.time<300 && distance(lastTap.pt,pt)<24){zoom(.5,pt.x,pt.y);lastTap=null;}else lastTap={time:now,pt};
    }else if(!reduced.matches && now-g.lastTime<75 && distance(g.start,pt)>6 && Math.hypot(g.vx,g.vy)>.07){
      const anchor=geoAt(W/2,H/2), km=center.km;
      animate(465,t=>{const travel=90*(1-Math.exp(-5*t));setAnchor(anchor,W/2+g.vx*travel,H/2+g.vy*travel,km);});
    }
  }
  map.addEventListener('pointerup',endPointer);map.addEventListener('pointercancel',endPointer);
  map.addEventListener('lostpointercapture',endPointer);
  map.addEventListener('dblclick',e=>{e.preventDefault();const p=localPoint(e);zoom(e.shiftKey?2:.5,p.x,p.y);});
  map.addEventListener('wheel',e=>{
    e.preventDefault();if(pointers.size)return;
    const p=localPoint(e);
    const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?H:1);
    zoom(Math.exp(clamp(delta*(e.ctrlKey ? .009 : .003),-.72,.72)),p.x,p.y,true);
  },{passive:false});
  map.addEventListener('keydown',e=>{
    if(e.target!==map)return;
    const step=e.shiftKey?200:64;
    const keys={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowDown:[0,step],ArrowUp:[0,-step]};
    if(keys[e.key]){
      e.preventDefault();stop();const [x,y]=keys[e.key],p=geoAt(W/2+x,H/2+y);
      center.lon=p.lon;center.lat=p.lat;invalidate();
    }else if(['+','=','-','_','Home'].includes(e.key)){
      e.preventDefault();if(e.key==='Home')goHome();else zoom(e.key==='-'||e.key==='_'?1.65:1/1.65);
    }
  });
  for(const [id,lon0] of [['near-side',0],['far-side',180]]) {
    $(id).addEventListener('click',e=>{
      const rect=$(id).querySelector('.globe').getBoundingClientRect();
      const x=(e.clientX-rect.left)*2/rect.width-1, y=1-(e.clientY-rect.top)*2/rect.height;
      
      if(e.detail && x*x+y*y<=1){
        const lon=lon0+Math.atan2(x,Math.sqrt(Math.max(0,1-x*x-y*y)))/DEG;
        flyTo({lon,lat:Math.asin(y)/DEG,km:center.km});
      }else flyTo({lon:lon0,lat:0,km:Math.min(130*KM/W,128*KM/H)});
    });
  }

  buildRegister();
  const layoutObserver = new ResizeObserver(fitSheet);
  layoutObserver.observe(document.querySelector('.sheet'));
  layoutObserver.observe(document.querySelector('.note-space'));
  window.addEventListener('resize',fitSheet);
  window.addEventListener('beforeprint', () => { stop(); fitSheet(); render(performance.now()); });
  window.addEventListener('afterprint',fitSheet);
  document.fonts.ready.then(fitSheet);
  fitSheet();
})();
