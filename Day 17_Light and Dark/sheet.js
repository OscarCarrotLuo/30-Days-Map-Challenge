(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const {start, slotMs, count, clamp, direction, observer, reading, calendar} = window.Solar;
  const sheet=document.querySelector('.sheet'), margin=document.querySelector('.note-space');
  const canvas=$('calendar'), days=count/96;
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const year=new Date(start).getUTCFullYear();
  const monthStarts=months.map((_,m) => (Date.UTC(year,m,1)-start)/(96*slotMs)).concat(days);
  const place=(name,lat,lon) => ({name,lat,lon});
  const places={
    earth:[
      place('Greenwich',51.4779,-.0015), place('Philadelphia',39.9526,-75.1652),
      place('Quito',-.1807,-78.4678), place('Tromsø',69.6492,18.9553),
      place('Nairobi',-1.2864,36.8172), place('Beijing',39.9042,116.4074), place('Sydney',-33.8688,151.2093)
    ],
    moon:[
      place('Copernicus',9.6209,-20.0786), place('Tycho',-43.2958,-11.2153),
      place('Peary',88.6251,24.4024), place('Mare Crisium',16.1774,59.1037),
      place('Mare Orientale',-19.8655,-94.6703), place('Tsiolkovskiy',-20.3789,128.9715),
      place('Henson',-88.57,-130.63)
    ]
  };
  for (const [id,stations] of Object.entries(places)) {
    for (const site of stations) site.normal=observer(id,site.lon,site.lat);
  }
  const selections={earth:places.earth[0],moon:places.moon[0]};
  const plate=window.createSolarPlate(places,site=>selectSite(site,false));
  const annualImage=document.createElement('canvas');
  const earthImage=$('earth-image'), moonImage=$('moon-image');
  annualImage.width=days; annualImage.height=96;
  let body='earth', slot=(Date.UTC(year,10,17,16)-start)/slotMs;
  let currentYear, transitions=[], stationRows=[], graph, timer=0, layoutFrame=0;
  let density=1, chartFont='', letter=10;

  const pad=n => String(n).padStart(2,'0');
  const shortDate=date => pad(date.getUTCDate())+' '+months[date.getUTCMonth()];
  const clock=date => pad(date.getUTCHours())+':'+pad(date.getUTCMinutes());
  const alt=n => (Math.abs(n)<.05 ? '' : n<0 ? '−' : '+')+Math.abs(n).toFixed(1)+'°';
  const coordinate=(x,isLat) => {
    const abs=Math.abs(x).toFixed(2);
    return abs+'°'+(Number(abs)===0 || (!isLat && Number(abs)===180) ? '' :
      isLat ? (x<0 ? 'S' : 'N') : (x<0 ? 'W' : 'E'));
  };

  function makeYear() {
    const site=selections[body];
    currentYear=calendar(body,site.normal);
    transitions=[];
    const ctx=annualImage.getContext('2d'), image=ctx.createImageData(days,96);
    for (let i=0;i<count;i++) {
      // Array time advances by quarter hours. On paper each column is one UTC date.
      const value=currentYear[i], j=4*((i%96)*days+Math.floor(i/96));
      image.data[j]=image.data[j+1]=image.data[j+2]=value;
      image.data[j+3]=255;
      if (i && (value>48)!==(currentYear[i-1]>48)) transitions.push(i);
    }
    ctx.putImageData(image,0,0);
    $('calendar-site').textContent=site.name==='Map point'
      ? coordinate(site.lat,true)+' / '+coordinate(site.lon,false) : site.name;
  }

  function drawCalendar() {
    const w=canvas.clientWidth,h=canvas.clientHeight;
    if (!w || !h) return;
    const pw=Math.round(w*density), ph=Math.round(h*density);
    if (canvas.width!==pw || canvas.height!==ph) {canvas.width=pw;canvas.height=ph;}
    const ctx=canvas.getContext('2d');
    ctx.setTransform(pw/w,0,0,ph/h,0,0);
    ctx.clearRect(0,0,w,h); ctx.font=chartFont;
    graph={x:letter*2.35,y:letter*.62,w:w-letter*2.85,h:h-letter*2.45};
    const g=graph;
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(annualImage,g.x,g.y,g.w,g.h);
    ctx.strokeStyle='#797873';ctx.lineWidth=.65;ctx.strokeRect(g.x,g.y,g.w,g.h);
    ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillStyle='#383835';
    for (const hour of [0,12,24]) {
      const y=g.y+(hour/24)*g.h;
      ctx.beginPath();ctx.moveTo(g.x-2.8,y);ctx.lineTo(g.x,y);ctx.stroke();
      ctx.fillText(pad(hour),g.x-4.5,y);
    }
    ctx.textAlign='center';ctx.textBaseline='top';
    const monthWidth=g.w/12;
    for (let m=0;m<12;m++) {
      const x=g.x+monthStarts[m]*g.w/days, next=g.x+monthStarts[m+1]*g.w/days;
      ctx.beginPath();ctx.moveTo(x,g.y+g.h);ctx.lineTo(x,g.y+g.h+3);ctx.stroke();
      if (m>0) {
        ctx.strokeStyle='rgba(140,136,132,.33)';
        ctx.beginPath();ctx.moveTo(x,g.y);ctx.lineTo(x,g.y+g.h);ctx.stroke();
        ctx.strokeStyle='#797873';
      }
      if (monthWidth>=2.07*letter || m%2===0)
        ctx.fillText(months[m].toUpperCase(),(x+next)/2,g.y+g.h+4);
    }
    const x=g.x+(Math.floor(slot/96)+.5)*g.w/days, y=g.y+(slot%96+.5)*g.h/96;
    ctx.strokeStyle='rgba(161,62,53,.85)';ctx.lineWidth=.8;
    ctx.beginPath();ctx.moveTo(x,g.y-3);ctx.lineTo(x,g.y+g.h+2);ctx.stroke();
    ctx.beginPath();ctx.arc(x,y,2.15,0,2*Math.PI);
    ctx.fillStyle='#983b35';ctx.strokeStyle='#fff6ee';ctx.lineWidth=1;ctx.fill();ctx.stroke();
  }

  function createRegister() {
    const rows=$('stations'); rows.replaceChildren();
    document.querySelector('.register-list').scrollTop=0;
    $('register-heading').textContent='Solar altitude · '+(body==='earth' ? 'Earth' : 'Moon');
    $('horizon-note').textContent=body==='earth' ? 'Clear sky · level horizon' : 'Level horizon · terrain shadows excluded';
    stationRows=places[body].map(site=>{
      const tr=document.createElement('tr');
      const name=tr.insertCell(), altitude=tr.insertCell(), light=tr.insertCell();
      const button=document.createElement('button');
      button.type='button';button.textContent=site.name;button.setAttribute('aria-label','Inspect '+site.name);
      name.append(button); rows.append(tr);
      tr.addEventListener('click',()=>selectSite(site,true));
      return {site,tr,altitude,light};
    });
  }

  function nextTransition() {
    // The first changed quarter-hour brackets the event. Display the sampling precision.
    let low=0, high=transitions.length;
    while (low<high) {
      const middle=(low+high)>>1;
      if (transitions[middle]<=slot) low=middle+1; else high=middle;
    }
    const next=transitions[low];
    if (next===undefined) return (currentYear[slot]>48 ? 'Lit' : 'Dark')+' through 31 Dec';
    const date=new Date(start+next*slotMs);
    return (currentYear[next]>48 ? 'Next light' : 'Next dark')+' ≈ '+shortDate(date)+' '+clock(date);
  }

  function render() {
    const suns={earth:direction('earth',slot),moon:direction('moon',slot)};
    const site=selections[body], sun=suns[body], status=reading(body,sun,site.normal);
    const date=new Date(start+slot*slotMs);
    const timeText=shortDate(date)+' '+year+' · '+clock(date)+' UTC';
    $('utc').textContent=timeText; $('utc').dateTime=date.toISOString();
    canvas.setAttribute('aria-valuenow',slot); canvas.setAttribute('aria-valuetext',timeText+', '+site.name+', '+status.light);
    $('earlier').disabled=slot===0; $('later').disabled=slot===count-1;
    for (const row of stationRows) {
      const result=row.site===site ? status : reading(body,sun,row.site.normal);
      row.altitude.textContent=alt(result.altitude);row.light.textContent=result.light;
      row.tr.setAttribute('aria-current',String(row.site===site));
    }
    $('site-name').textContent=site.name;
    $('site-coordinates').textContent=coordinate(site.lat,true)+' / '+coordinate(site.lon,false);
    $('site-reading').textContent=alt(status.altitude)+' · '+status.light+
      (status.light==='Partial' ? ' · '+Math.round(status.covered*100)+'% covered' : '');
    $('next-light').textContent=nextTransition();
    plate.update(body,suns,site); drawCalendar();
  }

  function playState(playing) {
    const button=$('play'), label=playing ? 'Pause time' : 'Play time forward';
    button.setAttribute('aria-pressed',String(playing));button.setAttribute('aria-label',label);button.title=label;
  }
  function pause() {
    if (timer) clearInterval(timer);
    timer=0;playState(false);
  }
  function setTime(value,manual=true) {
    if (manual) pause();
    const next=clamp(Math.round(value),0,count-1);
    if (next!==slot) {slot=next;render();}
    if (next===count-1) pause();
  }
  function selectSite(site,recenter) {
    pause();
    site.normal ??= observer(body,site.lon,site.lat);
    selections[body]=site;
    if (recenter) plate.locate(site);
    makeYear();render();
    $('selection').textContent=site.name+', '+$('site-reading').textContent+', '+$('next-light').textContent+' UTC';
  }
  for (const button of document.querySelectorAll('[data-body]')) {
    button.addEventListener('click',()=>{
      const id=button.dataset.body;
      if (id===body) return;
      body=id;
      for (const b of document.querySelectorAll('[data-body]')) b.setAttribute('aria-pressed',String(b===button));
      createRegister();makeYear();render();requestLayout();
      $('selection').textContent=(id==='earth' ? 'Earth' : 'Moon')+' map, '+selections[id].name;
    });
  }
  $('step').addEventListener('change',()=>{
    const unit=({1:'15 minutes',4:'One hour',96:'One day'})[$('step').value];
    for (const [id,suffix] of [['earlier',' earlier'],['later',' later']]) {
      $(id).title=unit+suffix;$(id).setAttribute('aria-label',unit+suffix);
    }
  });
  $('earlier').addEventListener('click',()=>setTime(slot-Number($('step').value)));
  $('later').addEventListener('click',()=>setTime(slot+Number($('step').value)));
  $('play').addEventListener('click',()=>{
    if (timer) {pause();return;}
    if (slot===count-1) setTime(0,false);
    playState(true);
    timer=setInterval(()=>setTime(slot+Number($('step').value),false),180);
  });
  document.addEventListener('visibilitychange',()=>{if (document.hidden) pause();});

  function timeAt(event) {
    if (!graph) return;
    const rect=canvas.getBoundingClientRect(), g=graph;
    const d=clamp(Math.floor((event.clientX-rect.left-g.x)/g.w*days),0,days-1);
    const q=clamp(Math.floor((event.clientY-rect.top-g.y)/g.h*96),0,95);
    setTime(d*96+q);
  }
  canvas.addEventListener('pointerdown',e=>{
    if (e.button!==0 || !e.isPrimary) return;
    canvas.setPointerCapture(e.pointerId);timeAt(e);
  });
  canvas.addEventListener('pointermove',e=>{if (canvas.hasPointerCapture(e.pointerId)) timeAt(e);});
  canvas.addEventListener('pointerup',e=>{if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);});
  canvas.addEventListener('keydown',e=>{
    const steps={ArrowLeft:-96,ArrowRight:96,ArrowUp:-1,ArrowDown:1,PageUp:-96*7,PageDown:96*7};
    if (e.key in steps) setTime(slot+steps[e.key]*(e.shiftKey ? 4 : 1));
    else if (e.key==='Home') setTime(0);
    else if (e.key==='End') setTime(count-1);
    else return;
    e.preventDefault();
  });

  function layout() {
    layoutFrame=0;
    const css=getComputedStyle(sheet);
    const w=sheet.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight);
    const h=sheet.clientHeight-parseFloat(css.paddingTop)-parseFloat(css.paddingBottom);
    const sideBySide=css.flexDirection==='row';
    sheet.toggleAttribute('data-foot',!sideBySide);
    let side;
    if (sideBySide) {
      side=Math.min(h,w-margin.getBoundingClientRect().width-parseFloat(css.columnGap),1340);
    } else if (matchMedia('(max-width: 580px) and (orientation: portrait)').matches) {
      side=w;
      margin.style.setProperty('--foot-width',w+'px');
    } else {
      const room=h-parseFloat(css.rowGap);
      let foot=Math.min(w,1340);
      for (let pass=0;pass<4;pass++) {
        margin.style.setProperty('--foot-width',foot+'px');
        side=Math.min(w,room-margin.getBoundingClientRect().height,1340);
        const next=Math.min(w,Math.max(Math.min(w, w>=580 ? 580 : 310),Math.floor(side)));
        if (next>=foot-1) break;
        foot=next;
      }
    }
    sheet.style.setProperty('--side',Math.max(1,Math.floor(side))+'px');
    const style=getComputedStyle(document.body);
    chartFont=style.fontWeight+' '+style.fontSize+' '+style.fontFamily;
    letter=parseFloat(style.fontSize);density=Math.min(3,window.devicePixelRatio||1);
    plate.resize();drawCalendar();
    if (earthImage.complete && moonImage.complete) sheet.dataset.ready='true';
  }
  function requestLayout() {
    if (!layoutFrame) layoutFrame=requestAnimationFrame(layout);
  }
  for (const image of [earthImage,moonImage]) image.addEventListener('load',requestLayout);
  new ResizeObserver(requestLayout).observe(sheet);
  new ResizeObserver(requestLayout).observe(margin);
  window.addEventListener('resize',requestLayout);
  window.addEventListener('beforeprint',layout);
  document.fonts.ready.then(requestLayout);
  createRegister();makeYear();render();layout();
})();
