(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const rad = Math.PI / 180;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;
  const start = Date.UTC(2026, 10, 1);
  const quarterHour = 15 * 60 * 1000;
  const epochs = window.sightEphemeris;
  const sites = [
    {body:'moon', name:'Copernicus', lon:-20.0786, lat:9.6209},
    {body:'moon', name:'Mare Orientale', lon:-94.6703, lat:-19.8655},
    {body:'moon', name:'Tycho', lon:-11.2153, lat:-43.2958},
    {body:'moon', name:'Tsiolkovskiy', lon:128.9715, lat:-20.3789},
    {body:'earth', name:'Philadelphia', lon:-75.1652, lat:39.9526},
    {body:'earth', name:'Greenwich', lon:-0.0015, lat:51.4779},
    {body:'earth', name:'Beijing', lon:116.4074, lat:39.9042},
    {body:'earth', name:'Sydney', lon:151.2093, lat:-33.8688}
  ];
  const bodies = [
    {id:'moon', target:'Earth', a:1737.4, e2:0, offset:0},
    {id:'earth', target:'Moon', a:6378.137, e2:0.0066943799901413165, offset:3}
  ];
  const sheet = document.querySelector('.sheet');
  const margin = document.querySelector('.note-space');
  const plate = document.querySelector('.plate');
  const slider = $('epoch');
  const reading = $('reading');
  let epoch = Number(slider.value);
  let selection = null;
  let pinned = false;
  let letter = 10;
  let chartFont = '';
  let pendingFrame = 0;

  function coord(n, latitude) {
    const value = Math.abs(n).toFixed(1);
    const axis = latitude ? ['N','S'] : ['E','W'];
    return value + '°' + (Number(value) === 0 ? '' : axis[Number(n < 0)]);
  }

  function altText(n) {
    const a = Math.abs(n).toFixed(1);
    return (Number(a) === 0 ? '' : n < 0 ? '−' : '+') + a + '°';
  }

  function canvasContext(canvas) {
    const {width, height} = canvas.getBoundingClientRect();
    const density = Math.min(4, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(width * density));
    const h = Math.max(1, Math.round(height * density));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(w / Math.max(1,width),0,0,h / Math.max(1,height),0,0);
    ctx.clearRect(0,0,width,height);
    ctx.font = chartFont;
    return {ctx, width, height};
  }

  // Vector origin is the body's centre of mass. Coordinates on Earth are geodetic.
  // Subtract the actual observer position before taking the local Up component.
  function sight(body, lon, lat) {
    const phi = lat * rad, lambda = lon * rad;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const cl = Math.cos(lambda), sl = Math.sin(lambda);
    const n = body.a / Math.sqrt(1 - body.e2 * sp * sp);
    const x = body.x - n * cp * cl;
    const y = body.y - n * cp * sl;
    const z = body.z - n * (1 - body.e2) * sp;
    const up = cp * (x * cl + y * sl) + z * sp;
    const east = -x * sl + y * cl;
    const north = -sp * (x * cl + y * sl) + cp * z;
    return Math.atan2(up, Math.hypot(east, north)) / rad;
  }

  function orient(body) {
    const sample = epochs[epoch];
    [body.x, body.y, body.z] = sample.slice(body.offset, body.offset + 3);
    body.range = Math.hypot(body.x, body.y, body.z);
    body.direction = Math.atan2(body.z, Math.hypot(body.x, body.y));
    body.lon = Math.atan2(body.y, body.x) / rad;
    // Latitude of the ellipsoid normal that passes through the target centre.
    let phi = body.direction;
    for (let i = 0; i < 3; i++) {
      const s = Math.sin(phi);
      const n = body.a / Math.sqrt(1 - body.e2 * s * s);
      phi = Math.atan2(body.z + n * body.e2 * s, Math.hypot(body.x, body.y));
    }
    body.lat = phi / rad;
  }

  const toX = (lon, width) => (lon + 180) * width / 360;
  const toY = (lat, height) => (90 - lat) * height / 180;

  function drawGrid(ctx, w, h) {
    ctx.beginPath();
    for (let lon = -150; lon <= 150; lon += 30) {
      const x = toX(lon,w);
      ctx.moveTo(x,0); ctx.lineTo(x,h);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = toY(lat,h);
      ctx.moveTo(0,y); ctx.lineTo(w,y);
    }
    ctx.lineWidth = .55;
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.88)';
    for (let lon = -150; lon <= 150; lon += 30) {
      for (let lat = -60; lat <= 60; lat += 30) {
        ctx.fillRect(toX(lon,w) - .8, toY(lat,h) - .8, 1.6, 1.6);
      }
    }
  }

  // A latitude slice of the visibility cap has one continuous longitude
  // interval about the sub-target meridian. Clip copies on both sides of the seam.
  function shadeHidden(body, ctx, w, h) {
    const intervals = [];
    const rows = Math.max(180, Math.ceil(h));
    const cd = Math.cos(body.direction), sd = Math.sin(body.direction);
    for (let i = 0; i <= rows; i++) {
      const phi = (90 - 180 * i / rows) * rad;
      const s = Math.sin(phi), c = Math.cos(phi);
      const surfaceUp = body.a * Math.sqrt(1 - body.e2 * s * s);
      const ratio = (surfaceUp / body.range - sd*s) / (cd*c);
      intervals.push(Math.acos(clamp(ratio, -1, 1)) / rad);
    }
    const path = new Path2D();
    path.rect(0,0,w,h);
    for (const copy of [-360,0,360]) {
      const center = body.lon + copy;
      path.moveTo(toX(center + intervals[0],w),0);
      for (let i = 1; i <= rows; i++)
        path.lineTo(toX(center + intervals[i],w), i*h/rows);
      for (let i = rows; i >= 0; i--)
        path.lineTo(toX(center - intervals[i],w), i*h/rows);
      path.closePath();
    }
    ctx.save();
    ctx.clip(path, 'evenodd');
    ctx.fillStyle = 'rgba(9,9,9,.43)';
    ctx.fillRect(0,0,w,h);
    ctx.beginPath();
    const pitch = Math.max(5,w / 115);
    for (let x = -h; x < w; x += pitch) {
      ctx.moveTo(x,h); ctx.lineTo(x+h,0);
    }
    ctx.lineWidth = .55;
    ctx.strokeStyle = 'rgba(255,255,255,.34)';
    ctx.stroke();
    ctx.restore();
  }

  function destination(body, bearing, distance) {
    const phi = body.lat * rad;
    const sd = Math.sin(distance), cd = Math.cos(distance);
    const s = Math.sin(phi)*cd + Math.cos(phi)*sd*Math.cos(bearing);
    const lat = Math.asin(clamp(s,-1,1));
    const dl = Math.atan2(Math.sin(bearing)*sd*Math.cos(phi), cd - Math.sin(phi)*s);
    return [wrap(body.lon + dl/rad), lat/rad];
  }

  function onContour(body, bearing, level) {
    // Start with the exact spherical solution. On WGS84 a small angular
    // correction accounts for the separation between the normal and radial.
    let d = Math.acos(body.a * Math.cos(level*rad) / body.range) - level*rad;
    let pt = destination(body, bearing, d);
    if (body.e2) {
      for (let i = 0; i < 2; i++) {
        d += (sight(body,...pt) - level)*rad;
        pt = destination(body, bearing, d);
      }
    }
    return pt;
  }

  function whiteLabel(ctx, text, x, y, align='left') {
    ctx.save();
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = 'rgba(20,20,20,.78)';
    ctx.strokeText(text,x,y);
    ctx.fillStyle = '#fff';
    ctx.fillText(text,x,y);
    ctx.restore();
  }

  function drawContours(body, ctx, w, h) {
    for (let level = 0; level < 90; level += 15) {
      ctx.beginPath();
      let last;
      for (let b = 0; b <= 360; b += .75) {
        const [lon,lat] = onContour(body,b*rad,level);
        const x = toX(lon,w), y = toY(lat,h);
        if (!last || Math.abs(x-last.x) > w/2) {
          if (last) {
            const shift = x < last.x ? w : -w;
            ctx.lineTo(x+shift,y);
            ctx.moveTo(last.x-shift,last.y);
            ctx.lineTo(x,y);
          } else ctx.moveTo(x,y);
        } else ctx.lineTo(x,y);
        last = {x,y};
      }
      ctx.lineWidth = level ? 1.55 : 3;
      ctx.strokeStyle = level ? 'rgba(21,21,21,.25)' : 'rgba(16,16,16,.7)';
      ctx.stroke();
      ctx.lineWidth = level ? .72 : 1.55;
      ctx.strokeStyle = level ? 'rgba(255,255,255,.91)' : '#fff';
      ctx.stroke();
    }
    // Reserve space for station names before setting contour labels.
    for (const level of [0,30,60,15,45,75]) {
      if (w < 525 && level % 30 !== 0) continue;
      const text = level === 0 ? '0°' : '+' + level + '°';
      for (const bearing of [320,40,135,225,286,55,115,205]) {
        const [lon,lat] = onContour(body,bearing*rad,level);
        const x = toX(lon,w), y = toY(lat,h);
        const width = ctx.measureText(text).width;
        const box = {x:x-width/2-3, y:y-letter*.75, w:width+6, h:letter*1.5};
        if (!placeLabel(body,box,w,h)) continue;
        whiteLabel(ctx,text,x,y,'center');
        break;
      }
    }
  }

  function placeLabel(body, box, width, height) {
    if (box.x < 2 || box.y < 2 || box.x + box.w > width-2 || box.y+box.h > height-2)
      return false;
    if (body.boxes.some(b => box.x < b.x+b.w && box.x+box.w > b.x &&
                             box.y < b.y+b.h && box.y+box.h > b.y)) return false;
    body.boxes.push(box);
    return true;
  }

  function cross(ctx, x, y, size) {
    ctx.beginPath();
    ctx.moveTo(x-size,y); ctx.lineTo(x+size,y);
    ctx.moveTo(x,y-size); ctx.lineTo(x,y+size);
    ctx.moveTo(x+size*.55,y);
    ctx.arc(x,y,size*.55,0,2*Math.PI);
    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.lineWidth = .9; ctx.strokeStyle = '#8b312a'; ctx.stroke();
  }

  function stationLabels(body, ctx, w, h) {
    const labels = [];
    for (const site of sites.filter(site=>site.body === body.id)) {
      const x = toX(site.lon,w), y = toY(site.lat,h);
      ctx.beginPath(); ctx.arc(x,y,1.8,0,2*Math.PI);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = .7; ctx.strokeStyle = '#333'; ctx.stroke();
      const sw = ctx.measureText(site.name).width;
      for (const [dx,dy] of [[5,-4],[-sw-5,-4],[5,7],[-sw-5,7]]) {
        const box = {x:x+dx-1, y:y+dy-letter*.68, w:sw+2, h:letter*1.36};
        if (placeLabel(body,box,w,h)) {
          labels.push([site.name,x+dx,y+dy]);
          body.hits.push({site,box});
          break;
        }
      }
    }
    return labels;
  }

  function drawMap(body) {
    const {ctx, width:w, height:h} = canvasContext(body.canvas);
    body.hits = [];
    body.boxes = [{x:0,y:0,w:letter*16,h:letter*2.6}];
    shadeHidden(body,ctx,w,h);
    drawGrid(ctx,w,h);
    const labels = stationLabels(body,ctx,w,h);
    drawContours(body,ctx,w,h);
    for (const label of labels) whiteLabel(ctx,...label);
    cross(ctx,toX(body.lon,w),toY(body.lat,h),4.4);
    if (selection?.body === body.id)
      cross(ctx,toX(selection.lon,w),toY(selection.lat,h),7);
  }

  // Orthographic view centred on the true zenith point of each observer body.
  function drawLocator(body) {
    const {ctx, width:w, height:h} = canvasContext(body.globe);
    if (!body.texture) return;
    const size = body.globe.width;
    const pixels = ctx.createImageData(size,size);
    const phi = body.lat*rad;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let row = 0; row < size; row++) {
      const y = 1-2*(row+.5)/size;
      for (let col = 0; col < size; col++) {
        const x = 2*(col+.5)/size-1;
        const q = 1-x*x-y*y;
        if (q<=0) continue;
        const z = Math.sqrt(q);
        const lat = Math.asin(clamp(y*cp+z*sp,-1,1))/rad;
        const lon = wrap(body.lon+Math.atan2(x,z*cp-y*sp)/rad);
        const i = clamp(Math.floor(90-lat),0,179)*360 + clamp(Math.floor(lon+180),0,359);
        const shade = body.texture[i] * (.8+.2*z);
        const dst = 4*(row*size+col);
        pixels.data[dst] = pixels.data[dst+1] = pixels.data[dst+2] = shade;
        pixels.data[dst+3] = Math.min(255,q*size*90);
      }
    }
    ctx.putImageData(pixels,0,0);
    cross(ctx,w/2,h/2,3.2);
  }

  function drawAxes() {
    const lo = canvasContext($('longitude'));
    const la = canvasContext($('latitude'));
    const w = lo.width, h = la.height/2;
    const step = w < 460 ? 90 : 60;
    for (const o of [lo,la]) {
      o.ctx.strokeStyle = '#454542'; o.ctx.lineWidth = .6; o.ctx.fillStyle = '#323230';
    }
    lo.ctx.textBaseline = 'top';
    for (let lon = -180; lon <= 180; lon += 15) {
      const x = toX(lon,w);
      const major = lon % step === 0;
      lo.ctx.beginPath(); lo.ctx.moveTo(x,0); lo.ctx.lineTo(x,major ? 4 : 2); lo.ctx.stroke();
      if (!major) continue;
      lo.ctx.textAlign = lon === -180 ? 'left' : lon === 180 ? 'right' : 'center';
      lo.ctx.fillText(Math.abs(lon)+'°'+(Math.abs(lon)===180||!lon?'':lon<0?'W':'E'),x,5);
    }
    for (let panel = 0; panel < 2; panel++) {
      for (let lat = -75; lat <= 75; lat += 15) {
        const y = panel*h + toY(lat,h);
        const major = lat % 30 === 0;
        la.ctx.beginPath(); la.ctx.moveTo(la.width,y); la.ctx.lineTo(la.width-(major?4:2),y); la.ctx.stroke();
        if (!major || (w < 460 && lat % 60 !== 0)) continue;
        la.ctx.save(); la.ctx.translate(la.width-5,y); la.ctx.rotate(-Math.PI/2);
        la.ctx.textAlign = 'center'; la.ctx.textBaseline = 'bottom';
        la.ctx.fillText(Math.abs(lat)+'°'+(lat<0?'S':lat>0?'N':''),0,0); la.ctx.restore();
      }
    }
  }

  function drawRuler() {
    const {ctx, width:w, height:h} = canvasContext($('ruler'));
    const y = h-5.5, base = h-4;
    const xAt = n => n/(epochs.length-1)*w;
    for (let day=0; day<30; day++) {
      const x = xAt(day*96), x2 = xAt(Math.min((day+1)*96,epochs.length-1));
      ctx.fillStyle = day%2===0 ? '#343432' : '#fff';
      ctx.fillRect(x,y,x2-x,base-y);
      ctx.fillStyle='#454542'; ctx.fillRect(x,base,x2-x,.5);
      ctx.fillRect(x, y-1, .55,3.2);
    }
    ctx.textBaseline='bottom';
    for (const day of [1,5,10,15,20,25,30]) {
      const x=xAt((day-1)*96);
      ctx.textAlign = day===1?'left':'center';
      ctx.fillStyle='#333'; ctx.fillText(String(day).padStart(2,'0'),x,y-3);
    }
    const x=xAt(epoch);
    ctx.beginPath(); ctx.moveTo(x,base); ctx.lineTo(x-2.8,h-.25); ctx.lineTo(x+2.8,h-.25);
    ctx.closePath(); ctx.fillStyle='#983b35'; ctx.fill();
  }

  function showReading() {
    if (!selection) { reading.hidden = true; return; }
    const body = bodies.find(b=>b.id===selection.body);
    if (selection.zenith) {
      selection.lon = body.lon;
      selection.lat = body.lat;
    }
    const alt = sight(body,selection.lon,selection.lat);
    const state = Math.abs(alt) < 1e-7 ? 'on horizon' : alt > 0 ? 'above horizon' : 'below horizon';
    const position = coord(selection.lat,true)+' / '+coord(selection.lon,false);
    const text = (selection.name ? selection.name+' · ' : '') + position + '\n' +
      body.target + ' ' + altText(alt) + ' · ' + state;
    if (text !== reading.textContent) reading.textContent = text;
    reading.hidden = false;
    const w = plate.clientWidth, h = w/2;
    const x = toX(selection.lon,w), y = toY(selection.lat,h) + body.offset/3*h;
    const top = y + 14 + reading.offsetHeight > w ? y-14-reading.offsetHeight : y+14;
    reading.style.left = clamp(x+9,3,w-reading.offsetWidth-3)+'px';
    reading.style.top = Math.max(2,top)+'px';
  }

  function render() {
    pendingFrame = 0;
    const type = getComputedStyle(document.body);
    letter = parseFloat(type.fontSize);
    chartFont = '500 '+letter+'px '+type.fontFamily;
    for (const body of bodies) orient(body);
    if (selection?.zenith) {
      const b = bodies.find(b=>b.id===selection.body);
      selection.lon=b.lon; selection.lat=b.lat;
    }
    for (const body of bodies) {
      drawMap(body);
      drawLocator(body);
    }
    drawAxes(); drawRuler();
    for (const site of sites) {
      const body = bodies.find(b=>b.id===site.body);
      site.altCell.textContent = altText(sight(body,site.lon,site.lat));
      site.row.classList.toggle('active', selection?.name===site.name);
    }
    const iso = new Date(start + epoch*quarterHour).toISOString();
    const printed = iso.slice(8,10)+' NOV 2026 · '+iso.slice(11,16)+' UTC';
    $('utc').dateTime = iso;
    $('utc').textContent = printed;
    slider.setAttribute('aria-valuetext',printed);
    $('earlier').disabled = epoch === 0;
    $('later').disabled = epoch === epochs.length-1;
    showReading();
  }
  function queueRender() {
    if (!pendingFrame) pendingFrame = requestAnimationFrame(render);
  }

  function fitSheet() {
    const css = getComputedStyle(sheet);
    const width = sheet.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    const height = sheet.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const horizontal = css.flexDirection === 'row';
    sheet.toggleAttribute('data-foot', !horizontal);
    let side;
    if (horizontal) {
      side = Math.min(height,width-margin.getBoundingClientRect().width-parseFloat(css.columnGap),1340);
    } else {
      const room = height-parseFloat(css.rowGap);
      const minFooter = Math.min(width,(width>=550?64:31)*parseFloat(css.fontSize));
      let footer = Math.min(width,1340);
      for (let pass=0; pass<4; pass++) {
        margin.style.setProperty('--foot-width',footer+'px');
        side = Math.min(width,room-margin.getBoundingClientRect().height,1340);
        const next = Math.max(minFooter,Math.floor(side));
        if (next>=footer-1) break;
        footer=next;
      }
    }
    sheet.style.setProperty('--side',Math.max(1,Math.floor(side))+'px');
    queueRender();
  }

  function select(point, pin=false) {
    selection = point ? {...point} : null;
    pinned = pin;
    queueRender();
  }
  function setEpoch(n) {
    epoch = clamp(n,0,epochs.length-1);
    slider.value = String(epoch);
    queueRender();
  }

  function positionAt(body, e) {
    const box = body.panel.getBoundingClientRect();
    const x=e.clientX-box.left, y=e.clientY-box.top;
    const label = (body.hits || []).find(({box:b}) =>
      x>=b.x && x<=b.x+b.w && y>=b.y && y<=b.y+b.h);
    if (label) return label.site;
    for (const s of sites.filter(s=>s.body===body.id)) {
      if (Math.hypot(x-toX(s.lon,box.width),y-toY(s.lat,box.height))<5) return s;
    }
    return {body:body.id,lon:clamp(x/box.width,0,1)*360-180,lat:90-clamp(y/box.height,0,1)*180};
  }

  for (const body of bodies) {
    body.panel = document.querySelector('[data-body="'+body.id+'"]');
    body.texture = Uint8Array.from(atob(window.locatorTextures[body.id]), char=>char.charCodeAt(0));
    body.canvas = body.panel.querySelector('canvas');
    const button = document.querySelector('[data-locator="'+body.id+'"]');
    body.globe = button.querySelector('canvas');
    button.addEventListener('click',()=>select({
      body:body.id, lon:body.lon, lat:body.lat, name:'Sub-'+body.target, zenith:true
    },true));
    body.panel.addEventListener('pointermove', e => {
      if (e.pointerType !== 'touch' && !pinned) select(positionAt(body,e));
    });
    body.panel.addEventListener('pointerleave',()=>{ if (!pinned) select(null); });
    body.panel.addEventListener('click',e=>select(positionAt(body,e),true));
    body.panel.addEventListener('keydown', e=>{
      const keys = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,1],ArrowDown:[0,-1]};
      if (e.key==='Enter' || e.key===' ') {
        e.preventDefault(); select({body:body.id,lon:body.lon,lat:body.lat},true); return;
      }
      if (!keys[e.key]) return;
      e.preventDefault();
      const pt = selection?.body===body.id ? selection : body;
      const [dx,dy] = keys[e.key], step=e.shiftKey?10:1;
      select({body:body.id,lon:wrap(pt.lon+step*dx),lat:clamp(pt.lat+step*dy,-90,90)},true);
    });
  }
  for (const [i,site] of sites.entries()) {
    const row = $('stations').insertRow();
    if (i && sites[i-1].body !== site.body) row.dataset.divider='';
    site.row = row;
    const button = document.createElement('button');
    button.textContent=site.name;
    button.setAttribute('aria-label','Inspect '+site.name);
    row.insertCell().append(button);
    row.insertCell().textContent=bodies.find(b=>b.id===site.body).target;
    site.altCell=row.insertCell();
    row.addEventListener('click',()=>select(site,true));
    button.addEventListener('focus',()=>select(site));
    button.addEventListener('blur',()=>{ if (!pinned) select(null); });
    row.addEventListener('pointerenter',e=>{ if(e.pointerType!=='touch' && !pinned) select(site); });
    row.addEventListener('pointerleave',()=>{ if (!pinned) select(null); });
  }
  slider.addEventListener('input',()=>setEpoch(Number(slider.value)));
  $('earlier').addEventListener('click',()=>setEpoch(epoch-4));
  $('later').addEventListener('click',()=>setEpoch(epoch+4));
  document.addEventListener('keydown',e=>{ if (e.key==='Escape') select(null); });
  document.addEventListener('click',e=>{
    if (!e.target.closest('.panel,.register,.hemisphere,.measurement') && selection) select(null);
  });
  window.addEventListener('resize',fitSheet);
  window.addEventListener('beforeprint',fitSheet);
  window.addEventListener('afterprint',fitSheet);
  fitSheet();
  document.fonts.ready.then(fitSheet);
})();
