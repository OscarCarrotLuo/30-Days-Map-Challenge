(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const map = $('map');
  const data = window.CELESTIAL_SURVEY;
  const archive = data.stats;
  const rad = Math.PI / 180;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const wrap = v => ((v % 360) + 360) % 360;
  const delta = v => wrap(v + 180) - 180;
  const count = n => n.toLocaleString('en-US');
  const home = {ra: data.boresight[0], dec: data.boresight[1], span: 24.4, global: false};
  const view = {...home};
  const skyImage = $('sky-texture'), fieldImage = $('field-texture');
  const fieldBounds = [319.21875, 258.75, 67.5, 21.09375];
  const kepler = data.facilities.indexOf('Kepler');
  const hosts = data.hosts.map(([name, ra, dec, inField, planets], id) => ({
    id, name, ra, dec, inField, planets, kepler: planets.some(p => p[1] === kepler)
  }));
  const byName = new Map(hosts.map(h => [h.name, h]));
  const featured = ['Kepler-11', 'Kepler-16', 'Kepler-22', 'Kepler-47', 'Kepler-186',
    'KOI-351', 'Kepler-452', 'TRAPPIST-1', '51 Peg', 'TOI-700'];
  const ranked = new Map(featured.map((name, i) => [name, i]));
  const ordered = [...hosts].sort((a, b) => (ranked.get(a.name) ?? 99) - (ranked.get(b.name) ?? 99)
    || a.name.localeCompare(b.name, 'en', {numeric: true}));
  const sky = $('sky');
  let size = 0, letter = 10, chartFont = '', dpr = 1;
  let selected = null, hovered = null, motion = null, frame = 0, equalSky = null;
  let visible = [], labelHits = [], gridGeometry = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function raText(ra, seconds = false) {
    const t = seconds ? Math.round(wrap(ra) * 240) % 86400 : (Math.round(wrap(ra)*4) % 1440)*60;
    const pad = n => String(n).padStart(2, '0');
    const hm = pad(Math.floor(t/3600)) + 'h ' + pad(Math.floor(t/60) % 60) + 'm';
    return seconds ? hm + ' ' + pad(t%60) + 's' : hm;
  }
  function decText(dec, digits = 1) {
    return (dec < 0 ? '−' : '+') + Math.abs(dec).toFixed(digits) + '°';
  }
  function displayName(host) {
    return host.name === 'KOI-351' ? 'Kepler-90' : host.name;
  }
  function setPaperText() {
    $('sky-share').textContent = archive.skyPercent.toFixed(2) + '%';
    $('sky-share').title = archive.area.toFixed(2) + ' square degrees in the union of all four seasonal detector footprints';
    $('field-count').textContent = count(archive.inField) + ' / ' + count(archive.planets);
    $('archive-share').textContent = archive.archivePercent.toFixed(1) + '%';
    $('snapshot-date').textContent = new Date(data.date + 'T12:00:00Z').toLocaleDateString('en-GB',
      {day:'numeric', month:'short', year:'numeric', timeZone:'UTC'});
    $('snapshot-date').dateTime = data.date;
  }
  function correctView() {
    view.ra = wrap(view.ra);
    view.span = clamp(view.span, .5, 145);
    view.dec = view.global ? 0 : clamp(view.dec, -90 + view.span/2, 90 - view.span/2);
  }
  function geometry(v, width) {
    const sy = width/v.span;
    const sx = v.global ? width/360 : Math.max(width/360, sy*Math.cos(v.dec*rad));
    return {...v, width, sx, sy, lo:v.ra - width/(2*sx), hi:v.ra + width/(2*sx),
      south:v.global ? -90 : v.dec - v.span/2, north:v.global ? 90 : v.dec + v.span/2};
  }
  const xAt = (g, ra) => g.width/2 - delta(ra - g.ra)*g.sx;
  const yAt = (g, dec) => g.global ? g.width*(1-Math.sin(dec*rad))/2 : g.width/2 + (g.dec-dec)*g.sy;
  function skyAt(g, x, y) {
    return {ra:wrap(g.ra + (g.width/2-x)/g.sx), dec:g.global
      ? Math.asin(clamp(1-2*y/g.width, -1, 1))/rad : g.dec + (g.width/2-y)/g.sy};
  }
  function canvasContext(canvas) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    const pw = Math.max(1, Math.round(w*dpr)), ph = Math.max(1, Math.round(h*dpr));
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(pw/w, 0, 0, ph/h, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }
  function invalidate() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  // The NASA texture is north-up, centered on zero hours, with RA increasing leftward.
  function drawPatch(ctx, g, img, [left, right, top, bottom]) {
    if (!img.naturalWidth) return;
    const n = Math.min(top, g.north), s = Math.max(bottom, g.south);
    if (n <= s) return;
    const first = Math.ceil((g.lo-left)/360), last = Math.floor((g.hi-right)/360);
    for (let turn=first; turn<=last; turn++) {
      const hi = Math.min(left+turn*360, g.hi), lo = Math.max(right+turn*360, g.lo);
      if (hi <= lo) continue;
      const sourceX = (left+turn*360-hi)/(left-right)*img.naturalWidth;
      const sourceY = (top-n)/(top-bottom)*img.naturalHeight;
      ctx.drawImage(img, sourceX, sourceY, (hi-lo)/(left-right)*img.naturalWidth,
        (n-s)/(top-bottom)*img.naturalHeight, (g.hi-hi)*g.sx, yAt(g,n), (hi-lo)*g.sx, (n-s)*g.sy);
    }
  }
  function equalAreaTexture() {
    if (equalSky || !skyImage.naturalWidth) return equalSky;
    equalSky = document.createElement('canvas');
    equalSky.width = 2048; equalSky.height = 1024;
    const ctx = equalSky.getContext('2d');
    for (let y=0; y<equalSky.height; y++) {
      const north = Math.asin(1-2*y/equalSky.height)/rad;
      const south = Math.asin(1-2*(y+1)/equalSky.height)/rad;
      ctx.drawImage(skyImage, 0, (90-north)/180*skyImage.naturalHeight, skyImage.naturalWidth,
        (north-south)/180*skyImage.naturalHeight, 0, y, equalSky.width, 1);
    }
    return equalSky;
  }
  function background(ctx, g) {
    const w = g.width;
    ctx.fillStyle = '#111'; ctx.fillRect(0,0,w,w);
    if (g.global) {
      const texture = equalAreaTexture();
      if (!texture) return;
      const shift = wrap(g.ra)/360*w;
      ctx.drawImage(texture, shift-w, 0, w, w);
      ctx.drawImage(texture, shift, 0, w, w);
    } else {
      drawPatch(ctx, g, skyImage, [180,-180,90,-90]);
      if (g.span < 64) drawPatch(ctx, g, fieldImage, fieldBounds);
    }
  }

  function niceStep(target, options) {
    return options.reduce((a,b) => Math.abs(Math.log(a/target)) < Math.abs(Math.log(b/target)) ? a : b);
  }
  function ticks(low, high, major) {
    const minor = major/10, values = [];
    for (let i=Math.ceil(low/minor-1e-7); i<=Math.floor(high/minor+1e-7); i++) {
      values.push({v:i*minor, major:i%10 === 0, half:i%5 === 0});
    }
    return values;
  }
  function graticule(ctx, g) {
    const num = clamp(size/148, 3.7, 6.5);
    const stepRA = g.global ? 45 : niceStep((g.hi-g.lo)/num, [.025,.0625,.125,.25,.5,1.25,2.5,3.75,5,7.5,10,15,30,45,60,90]);
    const stepDec = g.global ? 30 : niceStep(g.span/num, [.025,.05,.1,.2,.25,.5,1,2,3,4,5,10,15,20,30,45]);
    const xt = ticks(g.lo, g.hi, stepRA).map(t => ({...t, pos:(g.hi-t.v)*g.sx}));
    const yt = ticks(g.south, g.north, stepDec).map(t => ({...t, pos:yAt(g,t.v)}));
    ctx.beginPath();
    for (const t of xt) if (t.major) {ctx.moveTo(t.pos,0); ctx.lineTo(t.pos,size);}
    for (const t of yt) if (t.major) {ctx.moveTo(0,t.pos); ctx.lineTo(size,t.pos);}
    ctx.strokeStyle = 'rgba(245,245,245,.28)'; ctx.lineWidth = .55; ctx.stroke();
    ctx.beginPath();
    for (const x of xt) if (x.major) for (const y of yt) if (y.major) {
      ctx.moveTo(x.pos-2.5,y.pos); ctx.lineTo(x.pos+2.5,y.pos);
      ctx.moveTo(x.pos,y.pos-2.5); ctx.lineTo(x.pos,y.pos+2.5);
    }
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.stroke();
    axis($('right-ascension'), xt, false, v => raText(v, stepRA<.25));
    axis($('declination'), yt, true, v => decText(v, stepDec<.1 ? 2 : stepDec<1 ? 1 : 0));
  }
  function axis(canvas, marks, vertical, format) {
    const ctx = canvasContext(canvas);
    const depth = vertical ? canvas.clientWidth : canvas.clientHeight;
    ctx.font=chartFont; ctx.textBaseline='middle'; ctx.textAlign='center';
    ctx.fillStyle='#444'; ctx.strokeStyle='#777'; ctx.lineWidth=.65;
    const offset = Math.min(7+letter*.55, depth-letter*.65-1);
    ctx.beginPath();
    let last = -Infinity;
    for (const t of [...marks].sort((a,b) => a.pos-b.pos)) {
      const p=t.pos, len=t.major?6:t.half?4:2;
      if (vertical) {ctx.moveTo(depth,p);ctx.lineTo(depth-len,p);}
      else {ctx.moveTo(p,0);ctx.lineTo(p,len);}
      if (!t.major) continue;
      const label=format(t.v), half=ctx.measureText(label).width/2+2;
      if (p-half<0 || p+half>size || p-half<last) continue;
      ctx.save();
      if (vertical) {ctx.translate(depth-offset,p);ctx.rotate(-Math.PI/2);}
      else ctx.translate(p,offset);
      ctx.fillText(label,0,0); ctx.restore(); last=p+half;
    }
    ctx.stroke();
  }
  function drawScale(g) {
    const canvas=$('scale'), ctx=canvasContext(canvas);
    const width=canvas.clientWidth, height=canvas.clientHeight, room=width-3*letter;
    if (!ctx || room<=0) return;
    const pxPerDegree = g.sx/Math.cos(g.dec*rad);
    const maxStep = room/pxPerDegree/5;
    const power = 10**Math.floor(Math.log10(maxStep));
    const step = [1,2,2.5,5,10].filter(v => v*power<=maxStep).pop()*power;
    const cell=step*pxPerDegree, divisions=Math.min(6,Math.floor(room/cell+1e-8)-1);
    const widthPx=cell*(divisions+1), start=(width-widthPx)/2, zero=start+cell, y=height-4;
    ctx.strokeStyle='#242423'; ctx.fillStyle='#242423'; ctx.lineWidth=.65;
    ctx.strokeRect(start,y-1.5,widthPx,1.5);
    for(let i=0;i<5;i+=2) ctx.fillRect(start+cell*i/5,y-1.5,cell/5,1.5);
    for(let i=0;i<divisions;i+=2) ctx.fillRect(zero+i*cell,y-1.5,cell,1.5);
    ctx.font=chartFont; ctx.textAlign='center'; ctx.textBaseline='bottom'; ctx.beginPath();
    for(let i=-1;i<=divisions;i++) {
      const x=zero+i*cell;
      ctx.moveTo(x,y+.5);ctx.lineTo(x,y-3.5);
      ctx.fillText(String(Number((Math.abs(i)*step).toPrecision(4))),x,y-4);
    }
    ctx.stroke();
    canvas.setAttribute('aria-label',step+' degrees per major division at the center of the chart');
  }

  function detectorPaths(ctx, g, small=false) {
    if (!g.global && (g.south>53 || g.north<35 || Math.abs(delta(291-g.ra))>(g.hi-g.lo)/2+14)) return;
    ctx.beginPath();
    for (const [, ,corners] of data.spring) {
      // Unwrap about the first corner, then repeat only at the chart seam.
      const start=xAt(g,corners[0][0]), period=360*g.sx;
      for (const shift of [-period,0,period]) {
        if (start+shift < -4*g.sx || start+shift > g.width+4*g.sx) continue;
        corners.forEach(([ra,dec],i) => {
          const x=start+shift-delta(ra-corners[0][0])*g.sx, y=yAt(g,dec);
          if (i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        });
        ctx.closePath();
      }
    }
    ctx.fillStyle=small?'rgba(200,100,81,.10)':'rgba(190,82,68,.055)';ctx.fill();
    ctx.strokeStyle=small?'#cc897a':g.global?'#e49a88':'#c58274';
    ctx.lineWidth=small?.38:g.global?.76:clamp(g.width/1270,.55,.90);
    ctx.stroke();
  }
  function disk(path,x,y,r) {path.moveTo(x+r,y);path.arc(x,y,r,0,Math.PI*2);}
  function drawHosts(ctx,g) {
    const solid=new Path2D(), open=new Path2D(), hit=[];
    const r=g.global ? clamp(size/1010,.60,1.05) :
      clamp(size/730,.77,1.55)*clamp((24/g.span)**.18,.8,1.7);
    for (const h of hosts) {
      if (h.dec<g.south || h.dec>g.north) continue;
      const x=xAt(g,h.ra), y=yAt(g,h.dec);
      if (x<0 || x>size) continue;
      hit.push({host:h,x,y});
      disk(h.kepler?solid:open,x,y,h.kepler?r:r*(g.global?1.22:1.80));
    }
    ctx.lineWidth=g.global?.42:.65;
    ctx.strokeStyle='rgba(12,12,12,.72)';ctx.stroke(solid);
    ctx.fillStyle='#f8f7f1';ctx.fill(solid);
    ctx.strokeStyle=g.global?'rgba(235,235,230,.83)':'#ecebe5';
    ctx.lineWidth=g.global?.65:clamp(r*.76,.85,1.25);ctx.stroke(open);
    visible=hit;
  }
  function drawAnnotations(ctx,g) {
    const occupied=[], picks=[];
    ctx.font=chartFont; ctx.textBaseline='middle';
    function label(text,x,y,kind,host=null,force=false) {
      if (x<1 || x>size-1 || y<1 || y>size-1) return;
      const w=ctx.measureText(text).width, h=letter+3;
      const far = kind === 'field' ? clamp(size*.047,13,39) : 0;
      const offset=far || 5;
      for (const [side,up] of [[1,-1],[-1,-1],[1,1],[-1,1]]) {
        const tx=side>0 ? x+offset : x-offset-w, ty=y+up*(far || h*.62);
        const box=[tx-2,ty-h/2,tx+w+2,ty+h/2];
        if (box[0]<3 || box[1]<3 || box[2]>size-3 || box[3]>size-3) continue;
        if (!force && occupied.some(b => b[0]<box[2]+3 && b[2]>box[0]-3 && b[1]<box[3]+2 && b[3]>box[1]-2)) continue;
        occupied.push(box);
        if (kind==='field') {
          const end=side>0?tx:tx+w;
          ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(end-side*5,ty);ctx.lineTo(end,ty);
          ctx.strokeStyle='#dfa694';ctx.lineWidth=.8;ctx.stroke();
        }
        if (kind==='star') {
          ctx.strokeStyle='#eceae5';ctx.lineWidth=.65;ctx.beginPath();
          for (const [a,b] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            ctx.moveTo(x+a*2.7,y+b*2.7);ctx.lineTo(x+a*5.6,y+b*5.6);
          }
          ctx.stroke();
        }
        ctx.lineJoin='round';ctx.lineWidth=2.4;ctx.strokeStyle='rgba(13,13,13,.78)';
        ctx.textAlign='left';ctx.strokeText(text,tx,ty);
        ctx.fillStyle=kind==='field'?'#f4b6a5':'#faf9f5';ctx.fillText(text,tx,ty);
        if (host) picks.push({box,host});
        return;
      }
    }
    function hostLabel(h, primary=false) {
      if (!h) return;
      const x=xAt(g,h.ra), y=yAt(g,h.dec);
      if (x<0 || x>size || y<0 || y>size) return;
      if (primary) {
        ctx.beginPath();ctx.arc(x,y,5.3,0,Math.PI*2);
        ctx.lineWidth=1.15;ctx.strokeStyle='#edab99';ctx.stroke();
      }
      label(displayName(h),x,y,'host',h,primary);
    }
    if (selected) hostLabel(selected,true);
    if (hovered && hovered!==selected) hostLabel(hovered,true);
    const edgeCorner = data.spring[0][2][0];
    if (g.global) label('Kepler field',xAt(g,home.ra),yAt(g,home.dec),'field');
    else if (g.span>11 && g.span<78) label('Kepler focal plane',xAt(g,edgeCorner[0]),yAt(g,edgeCorner[1]),'field');
    const names=g.global?['TRAPPIST-1','51 Peg','TOI-700']:featured;
    for (const name of names) {
      const h=byName.get(name);
      if (h!==selected && h!==hovered) hostLabel(h);
    }
    if (!g.global && g.span<75) for (const [name,ra,dec] of data.stars) {
      label(name,xAt(g,ra),yAt(g,dec),'star');
    }
    labelHits=picks;
  }

  // A Hammer equal-area diagram locates the current window on the whole sphere.
  const locators = new Map();
  function hammer(ra,dec,w,h) {
    const lon = delta(ra-180)*rad, lat=dec*rad;
    const divisor = Math.sqrt(1+Math.cos(lat)*Math.cos(lon/2));
    return [w/2-(w/2-1)*Math.cos(lat)*Math.sin(lon/2)/divisor,
      h/2-(h/2-1)*Math.sin(lat)/divisor];
  }
  function locatorBase(kind,w,h) {
    const key=[kind,w,h,dpr,fieldImage.naturalWidth].join('/');
    if (locators.has(key)) return locators.get(key);
    const base=document.createElement('canvas');
    base.width=Math.max(1,Math.round(w*dpr));base.height=Math.max(1,Math.round(h*dpr));
    const ctx=base.getContext('2d');ctx.scale(base.width/w,base.height/h);
    if (kind==='all-sky') {
      ctx.fillStyle='#dfdedb';ctx.beginPath();
      ctx.ellipse(w/2,h/2,w/2-1,h/2-1,0,0,2*Math.PI);ctx.fill();ctx.clip();
      ctx.strokeStyle='#b3b2ad';ctx.lineWidth=.4;ctx.beginPath();
      for (const lon of [30,90,150,210,270,330]) for(let d=-90;d<=90;d+=5) {
        const [x,y]=hammer(lon,d,w,h);if(d===-90)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      }
      for (const lat of [-60,-30,0,30,60]) for(let a=.01;a<360;a+=3) {
        const [x,y]=hammer(a,lat,w,h);if(a===.01)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      }
      ctx.stroke();
      ctx.fillStyle='rgba(49,49,46,.52)';
      for (const host of hosts) {
        const [x,y]=hammer(host.ra,host.dec,w,h);ctx.fillRect(x-.25,y-.25,.5,.5);
      }
      const [x,y]=hammer(home.ra,home.dec,w,h);
      ctx.strokeStyle='#a64c41';ctx.lineWidth=1;ctx.strokeRect(x-1.4,y-1.4,2.8,2.8);
    } else {
      const g=geometry({...home,span:37},w);
      ctx.beginPath();ctx.arc(w/2,h/2,w/2-.5,0,Math.PI*2);ctx.clip();
      background(ctx,g);detectorPaths(ctx,g,true);
    }
    locators.set(key,base);
    return base;
  }
  function drawLocators(g) {
    for (const id of ['all-sky','kepler-field']) {
      const node=$(id).querySelector('canvas'), w=node.clientWidth, h=node.clientHeight;
      const ctx=canvasContext(node);
      if (!ctx) continue;
      ctx.drawImage(locatorBase(id,w,h),0,0,w,h);
      ctx.lineWidth=1;ctx.strokeStyle='#a94e41';
      if (id==='all-sky') {
        if (g.global) {
          ctx.beginPath();ctx.ellipse(w/2,h/2,w/2-1,h/2-1,0,0,2*Math.PI);ctx.stroke();
          continue;
        }
        const corners=[[g.lo,g.south],[g.hi,g.south],[g.hi,g.north],[g.lo,g.north],[g.lo,g.south]];
        ctx.beginPath();let prev=null;
        for(let i=0;i<4;i++) for(let j=0;j<=14;j++) {
          const t=j/14, a=corners[i],b=corners[i+1];
          const pt=hammer(a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1]),w,h);
          if (!prev || Math.abs(pt[0]-prev[0])>w/2)ctx.moveTo(...pt);else ctx.lineTo(...pt);
          prev=pt;
        }
        ctx.stroke();
        if (g.span<8) {
          const [x,y]=hammer(g.ra,g.dec,w,h);ctx.strokeRect(x-1.2,y-1.2,2.4,2.4);
        }
      } else if (!g.global) {
        const local=geometry({...home,span:37},w);
        const cx=xAt(local,g.ra), width=(g.hi-g.lo)*local.sx, top=yAt(local,g.north);
        ctx.save();ctx.beginPath();ctx.arc(w/2,h/2,w/2-.5,0,Math.PI*2);ctx.clip();
        ctx.strokeStyle='#e8a08f';
        ctx.strokeRect(cx-width/2,top,Math.max(1.8,width),Math.max(1.8,g.span*local.sy));ctx.restore();
      }
    }
  }
  function render(now) {
    frame=0;
    if (!size) return;
    if (motion) {
      const t=clamp((now-motion.start)/motion.duration,0,1), ease=1-(1-t)**3;
      const from=motion.from, to=motion.to;
      view.ra=from.ra+delta(to.ra-from.ra)*ease;view.dec=from.dec+(to.dec-from.dec)*ease;
      view.span=from.span*(to.span/from.span)**ease;
      if(t===1) motion=null; else invalidate();
    }
    correctView();
    const g=geometry(view,size), ctx=canvasContext(sky);
    gridGeometry=g;
    background(ctx,g);graticule(ctx,g);detectorPaths(ctx,g);drawHosts(ctx,g);drawAnnotations(ctx,g);
    drawScale(g);drawLocators(g);
    $('position').textContent=raText(g.ra,true)+' / '+decText(g.dec,2);
    const status=$('load-status');
    status.hidden=!!skyImage.naturalWidth && !!fieldImage.naturalWidth;
    if (!status.hidden && [skyImage,fieldImage].some(img => img.complete && !img.naturalWidth))
      status.textContent='Base image unavailable · open the single-file edition';
    map.dataset.ready=String(status.hidden);
    map.dataset.projection=g.global?'equal-area':'equidistant';
    map.dataset.span=String(g.span);
  }

  // Fit the square and the measured marginalia together, as on the lunar sheet.
  function fitSheet() {
    const sheet=document.querySelector('.sheet'), notes=document.querySelector('.note-space');
    const css=getComputedStyle(sheet);
    const width=sheet.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight);
    const height=sheet.clientHeight-parseFloat(css.paddingTop)-parseFloat(css.paddingBottom);
    const sideBySide=css.flexDirection==='row';
    sheet.toggleAttribute('data-foot',!sideBySide);
    let side;
    if(sideBySide) {
      side=Math.min(height,width-notes.getBoundingClientRect().width-parseFloat(css.columnGap),1340);
    } else {
      const room=height-parseFloat(css.rowGap);
      const minFooter=sheet.clientHeight<=720 ? width :
        Math.min(width,(width>=550?64:31)*parseFloat(css.fontSize));
      let footer=Math.min(width,1340);
      for(let pass=0;pass<4;pass++) {
        notes.style.setProperty('--foot-width',footer+'px');
        side=Math.min(width,room-notes.getBoundingClientRect().height,1340);
        const next=Math.max(minFooter,Math.floor(side));
        if(next>=footer-1)break;
        footer=next;
      }
    }
    sheet.style.setProperty('--side',Math.max(1,Math.floor(side))+'px');
    const type=getComputedStyle(document.body);
    letter=parseFloat(type.fontSize); chartFont=type.fontWeight+' '+type.fontSize+' '+type.fontFamily;
    dpr=Math.min(devicePixelRatio||1,3);size=map.clientWidth;invalidate();
  }
  function fly(to) {
    hovered=null;map.classList.remove('over-host');
    if(view.global && !to.global) {
      view.global=false;view.span=105;
    }
    if(to.global || reduced.matches) {
      motion=null;Object.assign(view,to);invalidate();return;
    }
    const dist=Math.hypot(delta(to.ra-view.ra)*Math.cos(view.dec*rad),to.dec-view.dec);
    motion={from:{...view},to,start:performance.now(),duration:clamp(360+dist*5,360,880)};
    invalidate();
  }
  function clearSelection() {
    if(selected) $('row-'+selected.id)?.removeAttribute('aria-current');
    selected=null;$('object-readout').hidden=true;
  }
  function goHome() {clearSelection();fly(home);}
  function showAllSky() {clearSelection();fly({ra:180,dec:0,span:145,global:true});}
  function showHost(host) {
    clearSelection(); selected=host;
    $('row-'+host.id)?.setAttribute('aria-current','true');
    const info=$('object-readout'), title=document.createElement('strong');
    title.textContent=displayName(host)+(host.name==='KOI-351'?' (KOI-351)':'');
    const position=document.createElement('p');
    position.textContent=raText(host.ra,true)+' / '+decText(host.dec,3);
    const members=document.createElement('p');
    const names=host.planets.map(p => p[0]);
    members.textContent=(names.length===1?'Planet ':'Planets ')+names.map(name => name.split(' ').at(-1)).join(', ');
    const methods=[...new Set(host.planets.map(p => data.methods[p[2]]))].join(', ');
    members.title=names.join(', ')+' · '+methods;
    info.replaceChildren(title,position,members);info.hidden=false;
    fly({ra:host.ra,dec:host.dec,span:Math.min(view.global?9:view.span,4.5),global:false});
  }
  let rowCount=0;
  function addRows(limit) {
    const body=$('host-rows'), fragment=document.createDocumentFragment();
    const end=Math.min(ordered.length,limit);
    for (;rowCount<end;rowCount++) {
      const h=ordered[rowCount], row=document.createElement('tr');
      row.id='row-'+h.id;row.dataset.host=String(h.id);
      if(h===selected)row.setAttribute('aria-current','true');
      const first=row.insertCell(), btn=document.createElement('button');
      btn.type='button';btn.textContent=displayName(h);
      btn.setAttribute('aria-label','Locate '+displayName(h)+', '+h.planets.length+' confirmed '+(h.planets.length===1?'planet':'planets'));
      first.append(btn);row.insertCell().textContent=raText(h.ra);row.insertCell().textContent=String(h.planets.length);
      fragment.append(row);
    }
    body.append(fragment);
  }
  const scroller=document.querySelector('.register-scroll');
  scroller.addEventListener('scroll',() => {
    if(scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-200)addRows(rowCount+125);
  },{passive:true});
  scroller.addEventListener('keydown',e => {if(e.key==='End')addRows(ordered.length);});
  $('host-rows').addEventListener('click',e => {
    const row=e.target.closest('tr[data-host]');if(row)showHost(hosts[Number(row.dataset.host)]);
  });
  $('all-sky').addEventListener('click',showAllSky);
  $('kepler-field').addEventListener('click',goHome);

  function pointerXY(e) {
    const b=map.getBoundingClientRect();return {x:e.clientX-b.left,y:e.clientY-b.top};
  }
  function hitAt(p,labels=true) {
    if(labels) for(const {box,host} of labelHits) {
      if(p.x>=box[0] && p.x<=box[2] && p.y>=box[1] && p.y<=box[3])return host;
    }
    let best=null, distance=7**2;
    for(const d of visible) {
      const sq=(d.x-p.x)**2+(d.y-p.y)**2;
      if(sq<distance){distance=sq;best=d.host;}
    }
    return best;
  }
  function anchorAt(world, p) {
    correctView();let g=geometry(view,size);
    if(!view.global) {
      view.dec=world.dec+(p.y-size/2)/g.sy;
      correctView();g=geometry(view,size);
    }
    view.ra=world.ra+(p.x-size/2)/g.sx;
    correctView();invalidate();
  }
  function zoomAt(factor,p) {
    motion=null;
    if(!gridGeometry)return;
    const anchor=skyAt(geometry(view,size),p.x,p.y);
    if(view.global) {
      if(factor>=1)return;
      Object.assign(view,{global:false,span:100,ra:anchor.ra,dec:anchor.dec});
    } else if(view.span*factor>150) {
      Object.assign(view,{ra:view.ra,dec:0,span:145,global:true});invalidate();return;
    } else view.span=clamp(view.span*factor,.5,145);
    anchorAt(anchor,p);
  }
  const pointers=new Map();
  let drag=null, pinch=null, usedPinch=false;
  function pair() {
    const [a,b]=[...pointers.values()];
    return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))};
  }
  map.addEventListener('pointerdown',e => {
    if(e.button!==0 && e.pointerType==='mouse')return;
    e.preventDefault();map.focus({preventScroll:true});motion=null;
    map.setPointerCapture(e.pointerId);
    const p=pointerXY(e);pointers.set(e.pointerId,p);
    if(pointers.size===1) {
      usedPinch=false;drag={start:p, sky:skyAt(geometry(view,size),p.x,p.y),moved:false};
    } else if(pointers.size===2) {pinch=pair();usedPinch=true;drag=null;}
    hovered=null;map.classList.add('dragging');invalidate();
  });
  map.addEventListener('pointermove',e => {
    const p=pointerXY(e);
    if(!pointers.has(e.pointerId)) {
      if(e.pointerType==='mouse' && !pointers.size) {
        const next=hitAt(p);
        if(next!==hovered){hovered=next;map.classList.toggle('over-host',!!next);invalidate();}
      }
      return;
    }
    pointers.set(e.pointerId,p);
    if(pointers.size>=2 && pinch) {
      const next=pair(), world=skyAt(geometry(view,size),pinch.x,pinch.y);
      zoomAt(pinch.d/next.d,pinch);anchorAt(world,next);pinch=next;
    } else if(drag) {
      if(Math.hypot(p.x-drag.start.x,p.y-drag.start.y)>3)drag.moved=true;
      if(drag.moved)anchorAt(drag.sky,p);
    }
  });
  function finishPointer(e) {
    if(!pointers.has(e.pointerId))return;
    const p=pointers.get(e.pointerId);
    const tapped=e.type==='pointerup' && pointers.size===1 && drag && !drag.moved && !usedPinch;
    pointers.delete(e.pointerId);pinch=null;drag=null;
    if(pointers.size===1) {
      const last=[...pointers.values()][0];
      drag={start:last,sky:skyAt(geometry(view,size),last.x,last.y),moved:true};
    } else if(pointers.size===2)pinch=pair();
    if(!pointers.size)map.classList.remove('dragging');
    if(tapped) {
      const h=hitAt(p);
      if(h)showHost(h);
      else if(view.global) {
        const at=skyAt(geometry(view,size),p.x,p.y);fly({...at,span:24.4,global:false});
      }
    }
  }
  for(const event of ['pointerup','pointercancel','lostpointercapture'])map.addEventListener(event,finishPointer);
  map.addEventListener('pointerleave',() => {if(!pointers.size && hovered){hovered=null;map.classList.remove('over-host');invalidate();}});
  map.addEventListener('wheel',e => {
    e.preventDefault();
    const unit=e.deltaMode===1?16:e.deltaMode===2?size:1;
    zoomAt(Math.exp(clamp(e.deltaY*unit*(e.ctrlKey?.009:.0025),-.8,.8)),pointerXY(e));
  },{passive:false});
  map.addEventListener('keydown',e => {
    const keys={ArrowRight:[1,0],ArrowLeft:[-1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if(keys[e.key]) {
      e.preventDefault();motion=null;
      const [dx,dy]=keys[e.key], g=geometry(view,size);
      const at=skyAt(g,size*(.5+dx*.14),size*(.5+dy*.14));
      view.ra=at.ra;view.dec=at.dec;invalidate();
    } else if(['+','=','-','_','Home','Escape'].includes(e.key)) {
      e.preventDefault();
      if(e.key==='Home')goHome();
      else if(e.key==='Escape'){clearSelection();hovered=null;invalidate();}
      else zoomAt(e.key==='-'||e.key==='_'?1.55:1/1.55,{x:size/2,y:size/2});
    }
  });
  for(const img of [skyImage,fieldImage]) {
    img.addEventListener('load',() => {locators.clear();invalidate();});img.addEventListener('error',invalidate);
  }
  setPaperText();addRows(100);fitSheet();
  const observer=new ResizeObserver(fitSheet);
  observer.observe(document.querySelector('.sheet'));observer.observe(document.querySelector('.note-space'));
  document.fonts.ready.then(fitSheet);
  window.addEventListener('resize',fitSheet);
  window.addEventListener('beforeprint',() => {motion=null;fitSheet();render(performance.now());});
  window.addEventListener('afterprint',fitSheet);
})();
