'use strict';
/*
 * moviebox-single.js — one file. MovieBox + sports + shorts.
 * Node 18+. Dependencies: express only.
 *   npm i express
 *   node moviebox-single.js        (PORT env, default 8787)
 */
const crypto = require('crypto');
const express = require('express');
const streamProxy = require('./moviebox-stream-proxy');

/* ============================ ENGINE ============================ */
const SECRET_DEFAULT_B64 = 'NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==';
const SECRET_ALT_B64 = 'WHFuMm5uTzQxL0w5Mm8xaXVYaFNMSFRiWHZZNFo1Wlo2Mm04bVNMQQ==';
const MODERN_UA = 'com.community.mbox.in/50020130 (Linux; U; Android 14; en_IN; Pixel 8; Build/UD1A.230803.041; Cronet/145.0.7582.0)';

// 18+ content is tagged in genre with these labels. Drop it everywhere.
const ADULT_TAGS = /(^|,s*)(erotic|hot|adult|aiadult|18+|xxx|porn|nude|nsfw)(s*,|$)/i;
function isAdultGenre(genre){ return !!genre && ADULT_TAGS.test(String(genre)); }
function isAdultSubject(x){
  if(!x || typeof x !== 'object') return false;
  const g = x.genre || (x.subject && x.subject.genre) || x.tag || '';
  return isAdultGenre(g);
}
// Recursively strip adult items from any array of subjects/shorts a response carries.
function stripAdult(node){
  if(Array.isArray(node)){
    const out = node.filter(x => !isAdultSubject(x)).map(stripAdult);
    return out;
  }
  if(node && typeof node === 'object'){
    const o = {};
    for(const k of Object.keys(node)){
      if((k==='items'||k==='list'||k==='subjects'||k==='shorts'||k==='data'||k==='results') && Array.isArray(node[k])){
        o[k] = node[k].filter(x => !isAdultSubject(x)).map(stripAdult);
      } else {
        o[k] = stripAdult(node[k]);
      }
    }
    return o;
  }
  return node;
}
const WEB_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
const NATIVE_API_BASE = 'https://api3.aoneroom.com';
const BOOTSTRAP_HOST = 'https://apig.inmoviebox.com';
const NATIVE_HOSTS = [NATIVE_API_BASE, BOOTSTRAP_HOST];
const BOOTSTRAP_PATH = '/wefeed-mobile-bff/tab/ranking-list?tabId=0&categoryType=4516404531735022304&page=1&perPage=1';
const WEB_DOMAINS = ['https://h5-api.aoneroom.com'];
const SPORTS_BASE = 'https://h5-sport-api.aoneroom.com/wefeed-h5api-bff';

const b64 = (s) => { s = s.replace(/-/g,'+').replace(/_/g,'/'); s += '='.repeat((4 - s.length % 4) % 4); return Buffer.from(s,'base64'); };
const md5hex = (b) => crypto.createHash('md5').update(b).digest('hex');
const randDevice = () => crypto.randomBytes(16).toString('hex');
const secretBytes = (alt=false) => b64(b64(alt?SECRET_ALT_B64:SECRET_DEFAULT_B64).toString('utf8'));
const xClientToken = (ts) => { const s=String(ts); return s+','+md5hex(Buffer.from(s.split('').reverse().join(''),'utf8')); };
const clientInfo = (dev) => JSON.stringify({package_name:'com.community.mbox.in',version_name:'4.0.03.0920.03',version_code:50020130,os:'android',os_version:'14',device_id:dev,install_store:'official',gaid:'1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d',brand:'Google',model:'Pixel 8',system_language:'en',net:'NETWORK_WIFI',region:'IN',timezone:'Asia/Calcutta',sp_code:''});

function canonical(method, accept, ctype, url, body, ts){
  const u = new URL(url); let path = u.pathname || '/';
  if(u.search){ const pairs=[]; for(const seg of u.search.slice(1).split('&')){ if(!seg)continue; const i=seg.indexOf('='); pairs.push(i<0?[seg,'']:[seg.slice(0,i),seg.slice(i+1)]); } pairs.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0); path += '?' + pairs.map(([k,v])=>k+'='+v).join('&'); }
  const bb = body?Buffer.from(body,'utf8'):null;
  return [method.toUpperCase(), accept||'', ctype||'', bb?String(bb.length):'', String(ts), bb?md5hex(bb.slice(0,102400)):'', path].join('\n');
}
const sign = (method, accept, ctype, url, body, ts, alt=false) => ts+'|2|'+crypto.createHmac('md5', secretBytes(alt)).update(canonical(method,accept,ctype,url,body,ts),'utf8').digest('base64');
function authHeaders(method,url,body,token,dev,alt=false,ctype='application/json',accept='application/json'){
  const ts=Date.now();
  const h={ 'user-agent':MODERN_UA, accept, 'content-type':ctype, connection:'keep-alive', 'x-client-token':xClientToken(ts), 'x-tr-signature':sign(method,accept,ctype,url,body,ts,alt), 'x-client-info':clientInfo(dev||randDevice()), 'x-client-status':'0', 'cf-ipcountry':'NG', 'x-forwarded-for':'105.112.1.1' };
  if(token) h.authorization='Bearer '+token;
  return h;
}
function extractPolicyResource(cookie){
  if(!cookie) return null;
  let m=cookie.match(/Edge-Cache-Cookie=urlprefix=([^:;\s]+)/);
  if(m){ try{ return b64(m[1]).toString('utf8').replace(/\/+$/,'')+'/index.mpd'; }catch(e){} }
  m=cookie.match(/CloudFront-Policy=([^;]+)/);
  if(m){ const raw=m[1]; for(const t of ['cf','std']){ try{ let s=t==='cf'?raw.replace(/-/g,'+').replace(/_/g,'='):raw; s+='='.repeat((4-s.length%4)%4); const data=JSON.parse(Buffer.from(s,'base64').toString('utf8')); for(const st of (data.Statement||[])){ if(st.Resource) return st.Resource.replace(/\*+$/,'').replace(/\/+$/,'')+'/index.mpd'; } }catch(e){} } }
  return null;
}
function orderedHosts(preferred){ const out=[]; for(const c of [preferred,...NATIVE_HOSTS]){ try{ const u=new URL(c); if(u.protocol!=='https:'||u.pathname.replace(/\/$/,'')!=='')continue; if(!out.includes(u.origin))out.push(u.origin); }catch(e){} } return out; }
function nativeUrls(p, preferred=NATIVE_API_BASE){
  if(p.startsWith('http')){ try{ const u=new URL(p); if(!orderedHosts(preferred).includes(u.origin)) return [p]; preferred=u.origin; p=u.pathname+(u.search||''); }catch(e){ return [p]; } }
  return orderedHosts(preferred).map(h=>h+p);
}

class MovieBoxEngine {
  constructor(){ this.deviceId=randDevice(); this.token=null; }
  async bootstrapToken(force=false){
    if(this.token && !force) return this.token;
    let region=false;
    for(const url of orderedHosts(BOOTSTRAP_HOST).map(h=>h+BOOTSTRAP_PATH)){
      try{
        const r = await fetch(url,{headers:authHeaders('GET',url,null,null,this.deviceId)});
        const xu = r.headers.get('x-user');
        if(r.status===200 && xu){ try{ const t=JSON.parse(xu).token; if(t){ this.token=t; return t; } }catch(e){} }
        try{ const j=await r.json(); if(String(j.message||'').toLowerCase().includes('region')) region=true; }catch(e){}
      }catch(e){ continue; }
    }
    throw new Error(region?'REGION_RESTRICTED':'SESSION_UNAVAILABLE');
  }
  async apiRequest(method, pathOrUrl, bodyDict=null, useToken=true, retryAuth=true){
    const urls = nativeUrls(pathOrUrl);
    if(useToken && !this.token) await this.bootstrapToken();
    const bodyStr = bodyDict!=null? JSON.stringify(bodyDict):null;
    let refreshed=false, lastStatus=null, lastErr=null;
    while(true){
      let refresh=false;
      for(const url of urls){
        let r;
        try{ r = await fetch(url,{method,headers:authHeaders(method,url,bodyStr,useToken?this.token:null,this.deviceId),body:bodyStr||undefined}); }catch(e){ lastErr=e; continue; }
        if(r.status===200) return r.json();
        lastStatus=r.status;
        if(useToken && retryAuth && !refreshed && (lastStatus===401||lastStatus===441)){ refresh=true; break; }
      }
      if(refresh){ await this.bootstrapToken(true); refreshed=true; continue; }
      if(lastStatus!=null) throw new Error('API returned HTTP '+lastStatus);
      if(lastErr) throw lastErr;
      throw new Error('API request failed');
    }
  }
  async search(query, page=1, perPage=20){
    const data=(await this.apiRequest('POST','/wefeed-mobile-bff/subject-api/search',{keyword:query,page,perPage})).data||{};
    let items = (data.items||data.list||[]).map(it=>{ 
      const s=it.subject||it; 
      return { 
        subject_id:String(s.subjectId), 
        title:s.title, 
        type:s.subjectType===1?'Movie':'Series', 
        subject_type:s.subjectType, 
        release_date:s.releaseDate, 
        imdb_rating:s.imdbRatingValue, 
        genre:s.genre, 
        cover:(s.cover&&s.cover.url)||null, 
        detail_path:s.detailPath, 
        language:s.language 
      }; 
    }).filter(x=>!isAdultGenre(x.genre));

    // STRICT FILTER: Only keep Movies (1) and Series (2). Drop music/audio/shorts (6) and junk.
    items = items.filter(x => {
      if (!x.title || !x.subject_id) return false;
      if (x.subject_type !== 1 && x.subject_type !== 2) return false;
      const t = x.title.toLowerCase();
      if (t.includes('mix') || t.includes('jukebox') || t.includes('dj ') || t.includes('playlist') || t.includes('remix') || t.includes('audio') || t.includes('mashup') || t.includes('covers')) return false;
      return true;
    });

    return items;
  }
  async getDetails(subjectId){
    const data=(await this.apiRequest('GET','/wefeed-mobile-bff/subject-api/get?subjectId='+subjectId)).data||{};
    const du=data.detailUrl||''; const dp=du.includes('/')?du.split('/').pop():du;
    return { subject_id:String(data.subjectId), title:data.title, subject_type:data.subjectType, type:data.subjectType===1?'Movie':'Series', description:data.description, release_date:data.releaseDate, duration:data.duration, imdb_rating:data.imdbRatingValue, genre:data.genre, country:data.countryName, language:data.language, cover:(data.cover&&data.cover.url)||null, detail_path:dp, dubs:(data.dubs||[]).filter(d=>d&&typeof d==='object').map(d=>({subject_id:String(d.subjectId),lang_name:d.lanName,language:d.language})) };
  }
  async getEpisodes(subjectId){
    const seasons=((await this.apiRequest('GET','/wefeed-mobile-bff/subject-api/season-info?subjectId='+subjectId)).data||{}).seasons||[];
    return seasons.map(s=>({season:s.se,episode_count:s.maxEp,resolutions:s.resolutions||[]}));
  }
  async getStreams(subjectId, season=0, episode=0, detailPath=null){
    if(!detailPath){ try{ detailPath=(await this.getDetails(subjectId)).detail_path||''; }catch(e){ detailPath=''; } }
    const token = await this.bootstrapToken();
    const streams=[]; const seen=new Set();
    const q=(resStr)=>{ let v=0; for(const n of [2160,1440,1080,720,480,360,240]) if(String(resStr).includes(String(n))){v=n;break;} return v; };
    for(const domain of WEB_DOMAINS){
      const playUrl = `${domain}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${season}&ep=${episode}&detailPath=${detailPath}&streamSignType=1&supportCodecs%5Bhevc%5D=1&supportCodecs%5Bh264%5D=1`;
      const referer = `${domain}/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=&detailEp=&lang=en`;
      const headers = { 'User-Agent':WEB_UA, Referer:referer, Accept:'application/json', 'x-client-info':'{"timezone":"Asia/Calcutta"}', 'x-request-lang':'en', 'x-vip-restrict':'0', 'x-no-high-risk-restrict':'0', 'x-source':'moviebox', Authorization:'Bearer '+token };
      try{
        const r = await fetch(playUrl,{headers}); if(r.status!==200) continue;
        const data=(await r.json()).data||{}; const raw=data.streams||[]; const dash=data.dash||[];
        if(raw.length||dash.length){
          for(const st of raw){ if(!st.url||seen.has(st.url))continue; seen.add(st.url); const sb=parseInt(st.size||0); const qv=q(st.resolutions);
            streams.push({ source:'Web CDN ('+domain+')', format:st.format||'MP4', quality:qv?qv+'p':String(st.resolutions||'unknown'), quality_value:qv, resolution_tag:String(st.resolutions||'unknown'), url:st.url, size_bytes:sb||null, size_mb:sb?Math.round(sb/1048576*10)/10:0, codec:st.codecName, duration_sec:st.duration, headers:{'User-Agent':WEB_UA,Referer:'https://moviebox.ph/',Origin:'https://moviebox.ph'} }); }
          for(const d of dash){ if(!d.url)continue; const mpd=d.signCookie?extractPolicyResource(d.signCookie):null; const finalUrl=mpd||d.url; if(seen.has(finalUrl))continue; seen.add(finalUrl); const rt=String(d.resolutions||'adaptive');
            streams.push({ source:'Web DASH ('+domain+')', format:'DASH', quality:rt.includes('1080')?'1080p (Adaptive)':'Adaptive', quality_value:rt.includes('1080')?1080:999, resolution_tag:rt, url:finalUrl, size_mb:0, codec:'hevc/h264', duration_sec:null, cookie:d.signCookie, headers:{'User-Agent':WEB_UA,Referer:'https://moviebox.ph/',Origin:'https://moviebox.ph'} });
          }
          break;
        }
      }catch(e){ continue; }
    }
    let capStreamId='';
    try{
      const nd=(await this.apiRequest('GET','/wefeed-mobile-bff/subject-api/play-info?subjectId='+subjectId+'&se='+season+'&ep='+episode)).data||{};
      for(const st of (nd.streams||[])){ if(!st.url||seen.has(st.url)||st.url.includes('b164fbfb4347792950bdfbfb563d39d9'))continue; seen.add(st.url); const sb=parseInt(st.size||0); const qv=q(st.resolutions); if(!capStreamId&&st.id)capStreamId=String(st.id);
        streams.push({ source:'Mobile Native CDN', format:st.format||'MP4', quality:qv?qv+'p':String(st.resolutions||'unknown'), quality_value:qv, resolution_tag:String(st.resolutions||'unknown'), url:st.url, size_bytes:sb||null, size_mb:sb?Math.round(sb/1048576*10)/10:0, codec:st.codecName, duration_sec:st.duration, headers:{'User-Agent':MODERN_UA,Referer:'https://api3.aoneroom.com/',Cookie:st.signCookie||''} });
      }
    }catch(e){}
    if(capStreamId) for(const s of streams) s._caption_stream_id=capStreamId;
    streams.sort((a,b)=>b.quality_value-a.quality_value);
    return streams;
  }
  async getSubtitles(subjectId, streamId=null, season=0, episode=0){
    const subs=[]; const seen=new Set();
    if(!streamId){ try{ const rs=((await this.apiRequest('GET','/wefeed-mobile-bff/subject-api/play-info?subjectId='+subjectId+'&se='+season+'&ep='+episode)).data||{}).streams||[]; if(rs.length&&rs[0].id) streamId=String(rs[0].id); }catch(e){} }
    const add=(it)=>{ const u=it.url; if(u&&!seen.has(u)){ seen.add(u); subs.push({ id:String(it.id||''), language:it.lanName||it.language||'English', code:it.lan||'', url:u, size:it.size||null }); } };
    const reqs=[]; if(streamId) reqs.push('/wefeed-mobile-bff/subject-api/get-stream-captions?subjectId='+subjectId+'&streamId='+streamId);
    reqs.push('/wefeed-mobile-bff/subject-api/get-ext-captions?subjectId='+subjectId+'&resourceId='+(streamId||'0')+'&episode='+episode);
    const fetchCaps=async(url)=>{ try{ const data=(await this.apiRequest('GET',url)).data||{}; const items=Array.isArray(data)?data:(data.extCaptions||data.captions||[]); return items.filter(x=>x&&typeof x==='object'); }catch(e){ return []; } };
    for(const arr of await Promise.all(reqs.map(fetchCaps))) for(const it of arr) add(it);
    return subs;
  }
}

/* ============================ SPORTS ============================ */
const SPORTS_HEADERS={'Referer':'https://sportsnow.top/','Origin':'https://sportsnow.top','User-Agent':'Mozilla/5.0','Accept':'application/json'};
async function sportsGet(path, params={}){ const qs=new URLSearchParams(params).toString(); const r=await fetch(SPORTS_BASE+path+(qs?'?'+qs:''),{headers:SPORTS_HEADERS}); const j=await r.json(); if(j.code!==0) throw new Error('UPSTREAM_REJECTED'); return j.data; }
async function sportsPost(path, body){ const r=await fetch(SPORTS_BASE+path,{method:'POST',headers:{...SPORTS_HEADERS,'content-type':'application/json'},body:JSON.stringify(body)}); const j=await r.json(); if(j.code!==0) throw new Error('UPSTREAM_REJECTED'); return j.data; }

/* ============================ SERVER ============================ */
const engine = new MovieBoxEngine();
const app = express();
app.use(express.json({limit:'1mb'}));

async function webPost(path, body){
  const ts=Math.floor(Date.now()/1000);
  const token=ts+','+crypto.createHash('md5').update(String(ts).split('').reverse().join('')).digest('hex');
  const r=await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff'+path,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0','X-Client-Token':token},body:JSON.stringify(body)});
  if(!r.ok) throw new Error('web '+path+' HTTP '+r.status);
  const j=await r.json();
  if(j.code!==0 && j.code!==200 && j.code!==undefined) throw new Error(j.message||('code '+j.code));
  return j.data||j;
}
const NATIVE_PATHS = new Set(['/subject-api/search','/subject-api/search/v2','/subject-api/get','/subject-api/season-info','/subject-api/play-info','/subject-api/get-stream-captions','/subject-api/get-ext-captions','/subject-api/trending/v2','/subject-api/list','/subject-api/top-rec','/subject-api/bottom-tab','/subject-api/filter-items','/subject-api/search-suggest','/subject-api/search-rank/v2','/subject-api/resource','/subject-api/dub-info','/shorts/most-trending','/shorts/reel','/shorts/operating','/shorts/get-info','/shorts/mini-list','/shorts/dub-info','/shorts/favorite','/shorts/favorite-list','/shorts/get-mini-captions']);
const WEB_PATHS = new Set(["/subject/filter","/subject/play","/subject/search-suggest","/subject/everyone-search","/home"]);
const WEB_BASE = 'https://h5-api.aoneroom.com';

const NATIVE_POST_PATHS = new Set(['/subject-api/search','/subject-api/search/v2','/subject-api/trending/v2','/subject-api/list','/subject-api/top-rec','/shorts/most-trending','/shorts/reel','/shorts/favorite']);
const fail=(res,message,status=503,code='UNAVAILABLE')=>res.status(status).json({ok:false,error:message,code});

function subFormat(c){ if(c.format) return c.format; const s=parseInt(c.size||0); if(s>0&&s<20000)return 'srt'; if(s>0&&s<40000)return 'vtt'; return 'srt'; }

// 🟢 LINKING PROXY TO STREAM & DOWNLOAD URLS TO PREVENT 429 ERRORS
async function streamsOp(subjectId, season=0, episode=0, detailPath, reqHost){
  if(!/^\d+$/.test(subjectId)) throw new Error('INVALID_REQUEST');
  const rows = await engine.getStreams(subjectId, season, episode, detailPath||null);
  if(!rows.length) throw new Error('NO_MEDIA');
  const capId = (rows.find(r=>r._caption_stream_id)||{})._caption_stream_id;
  const captions = await engine.getSubtitles(subjectId, capId, season, episode);
  const fullDur = Math.max(0, ...rows.map(r=>parseFloat(r.duration_sec||0)));
  
  const PORT = process.env.PORT || 8787;
  const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

  const out=[];
  for(const row of rows){
    if(!row.url) continue;
    const dur=parseFloat(row.duration_sec||0);
    if(fullDur>600 && dur>0 && dur<fullDur/2) continue;
    let fmt=String(row.format||'mp4').toLowerCase(); fmt=(fmt==='dash'||fmt==='mpd')?'dash':(fmt==='hls'||fmt==='m3u8')?'hls':'mp4';
    let quality=parseInt(row.quality_value||0); if(quality===999||fmt==='dash') quality=0;
    let size=row.size_bytes; size=(size&&/^\d+$/.test(String(size)))?parseInt(size):null;
    const headers={...(row.headers||{})}; for(const k of Object.keys(headers)) if(!headers[k]) delete headers[k];
    if(row.cookie) headers.Cookie=row.cookie;

    // Wrap raw CDN URL with proxy token to avoid 429 rate limiting
    const token = streamProxy.remember(row.url, headers);
    const proxyUrl = `${BASE_URL}/media/segment/${token}`;

    out.push({ 
      resourceId:String(row.id||out.length), 
      url: proxyUrl, // Proxied URL for safe downloading and streaming
      resolution:quality, 
      format:fmt, 
      size, 
      sizeBytes:size, 
      duration:row.duration_sec||0, 
      codecName:row.codec||'', 
      headers: {}, // Handled securely by proxy server
      signCookie:'', 
      requireMemberType:parseInt(row.requireMemberType||0), 
      subtitles: captions.filter(c=>c.url).map(c=>({url:c.url, lan:c.code||'', lanName:c.language||'', format:subFormat(c)})) 
    });
  }
  if(!out.length) throw new Error('NO_MEDIA');
  return out;
}

app.post(['/internal/movie','/api-server/internal/movie'], async (req,res)=>{
  const p=req.body||{}; const op=p.operation;
  try{
    if(op==='native'){
      if(!NATIVE_PATHS.has(p.path)) return fail(res,'Unsupported operation',400,'INVALID_REQUEST');
      const method=NATIVE_POST_PATHS.has(p.path)?'POST':'GET';
      let path='/wefeed-mobile-bff'+p.path;
      if(method==='GET'&&p.params){ const q=new URLSearchParams(p.params).toString(); if(q) path+='?'+q; }
      const raw=await engine.apiRequest(method,path,method==='POST'?(p.body||{}):null);
      if(!raw||raw.code!==0){ if(String((raw&&raw.message)||'').toLowerCase().includes('region')) throw new Error('REGION_RESTRICTED'); throw new Error('UPSTREAM_REJECTED'); }
      const payload = raw.data!==undefined?raw.data:raw;
      return res.json({ok:true,data:stripAdult(payload)});
    }
    if(op==='web'){
      if(!WEB_PATHS.has(p.path)) return fail(res,'Unsupported operation',400,'INVALID_REQUEST');
      let url=WEB_BASE+'/wefeed-h5api-bff'+p.path;
      if(p.params){ const q=new URLSearchParams(p.params).toString(); if(q) url+='?'+q; }
      const method=p.body!==undefined&&p.body!==null?'POST':'GET';
      const hdrs={'User-Agent':WEB_UA,'Referer':'https://moviebox.ph/','Accept':'application/json'};
      const r=await fetch(url,{method,headers:hdrs,...(method==='POST'?{body:JSON.stringify(p.body),'Content-Type':'application/json'}:{})});
      const j=await r.json().catch(()=>({}));
      let data=j&&j.data!==undefined?j.data:j;
      if(p.path==='/subject/search-suggest'&&data&&typeof data==='object'){ const rows=data.items||[]; data={items:rows.filter(x=>x&&typeof x==='object').map(x=>({word:String(x.word||x.title||'').trim(),type:x.type})).filter(x=>x.word),keyword:data.keyword||''}; }
      if(p.path==='/subject/everyone-search'&&data&&typeof data==='object'){ const rows=data.everyoneSearch||[]; data={everyoneSearch:rows.filter(x=>x&&typeof x==='object').map(x=>({title:String(x.title||x.word||x.name||'').trim()})).filter(x=>x.title)}; }
      return res.json({ok:true,data});
    }
    if(op==='streams'){ return res.json({ok:true,data:await streamsOp(p.subjectId,p.season||0,p.episode||0,p.detailPath)}); }
    if(op==='sports'){
      const st=String((p.params&&p.params.sportType)||'football').toLowerCase();
      if(!['football','basketball'].includes(st)) throw new Error('INVALID_REQUEST');
      let data; const P=p.params||{};
      switch(p.action){
        case 'list': data=await sportsGet('/live/match-list-v5',{sportType:st,currentTagId:'0'}); break;
        case 'leagues': data=await sportsGet('/live/league-tab',{sportType:st}); break;
        case 'featured': case 'aggregate': data=await sportsGet('/sport/aggregate-v1',{leagueId:'0'}); break;
        case 'standings': { const l=String(P.leagueId||''); if(!/^\d+$/.test(l))throw new Error('INVALID_REQUEST'); data=await sportsGet('/live/league-ranking-list',{leagueId:l}); break; }
        case 'news': data=await sportsGet('/news/trending',{}); break;
        case 'article': { const i=String(P.id||''); if(!/^\d+$/.test(i))throw new Error('INVALID_REQUEST'); data=await sportsGet('/news/detail',{id:i}); break; }
        case 'highlights': data=await sportsGet('/sport/aggregate-v2',{}); break;
        case 'leagueBoard': data=await sportsGet('/live/match-board-league',{}); break;
        case 'leagueTeams': { const l=String(P.leagueId||''); if(!/^\d+$/.test(l))throw new Error('INVALID_REQUEST'); data=await sportsGet('/live/league-team-vote-list',{leagueId:l}); break; }
        case 'newsTags': data=await sportsGet('/news/tags',{}); break;
        case 'newsTag': data=await sportsPost('/news/trending-tag',p.body||{}); break;
        case 'matchEvents': { const m=String(P.matchId||''); if(!/^\d+$/.test(m))throw new Error('INVALID_REQUEST'); data=await sportsGet('/live/match-events',{match_id:m}); break; }
        case 'matchLineup': { const m=String(P.matchId||''); if(!/^\d+$/.test(m))throw new Error('INVALID_REQUEST'); data=await sportsGet('/live/match-lineup',{match_id:m}); break; }
        case 'matchH2h': { const m=String(P.matchId||''); if(!/^\d+$/.test(m))throw new Error('INVALID_REQUEST'); data=await sportsGet('/live/match-h2h',{match_id:m}); break; }
        case 'leagueTeamList': { const l=String(P.leagueId||''); if(!/^\d+$/.test(l))throw new Error('INVALID_REQUEST'); data=await sportsGet('/live/league-team-list',{leagueId:l,sportType:st}); break; }
        default: throw new Error('INVALID_REQUEST');
      }
      return res.json({ok:true,data});
    }
    return fail(res,'Unsupported operation',400,'INVALID_REQUEST');
  }catch(e){
    const known=new Set(['REGION_RESTRICTED','SESSION_UNAVAILABLE','UPSTREAM_REJECTED','NO_MEDIA','INVALID_REQUEST']);
    let code = known.has(e.message)?e.message:'UPSTREAM_UNAVAILABLE';
    const m=e.message.match(/API returned HTTP (\d{3})/); if(m) code='UPSTREAM_HTTP_'+m[1];
    const status = code==='NO_MEDIA'?404:code==='INVALID_REQUEST'?400:code==='REGION_RESTRICTED'?403:503;
    return fail(res,'Content is temporarily unavailable',status,code);
  }
});

app.get('/health',(req,res)=>res.json({ok:true,service:'moviebox-single'}));
app.get('/movies/trending',async(req,res)=>{ try{ const raw=await engine.apiRequest('POST','/wefeed-mobile-bff/subject-api/trending/v2',{page:+(req.query.page||1),pageSize:+(req.query.pageSize||20)}); res.json({ok:true,data:stripAdult(raw.data)}); }catch(e){ fail(res,e.message,503,e.message);} });

// STRICT MOVIE/SERIES SEARCH ENDPOINT (Filtering out music & junk)
app.get('/movies/search',async(req,res)=>{
  const q=String(req.query.q||''), page=+(req.query.page||1);
  try{ 
    const resList = await engine.search(q,page);
    if(resList && resList.length > 0) {
      return res.json({ok:true, data: resList});
    }
  }catch(e){ /* native search failed, fall back to web upstream */ }
  
  try{
    const sug=await webPost('/subject/search-suggest',{keyword:q,perPage:10});
    const words=(sug.items||[]).map(x=>String(x.word||x.title||'').trim()).filter(Boolean);
    const searchWords = [q, ...words].filter(Boolean);
    const seen=new Set(); const out=[];
    for(const w of searchWords.slice(0,3)){
      try{
        const f=await webPost('/subject/filter',{subjectType:1,page,perPage:20,keyword:w,genre:'All',sort:'ForYou'});
        for(const it of (f.items||[])){ 
          const id=String(it.subjectId||''); 
          if(!id||seen.has(id))continue; 
          const title = it.title || '';
          const tLower = title.toLowerCase();
          if(isAdultGenre(it.genre)) continue;
          if(tLower.includes('mix') || tLower.includes('jukebox') || tLower.includes('dj') || tLower.includes('playlist') || tLower.includes('remix') || tLower.includes('audio')) continue;
          seen.add(id);
          out.push({
            subject_id:id,
            title:it.title,
            type:it.subjectType===1?'Movie':'Series',
            subject_type:it.subjectType,
            release_date:it.releaseDate,
            imdb_rating:it.imdbRatingValue,
            genre:it.genre,
            cover:(it.cover&&it.cover.url)||null,
            detail_path:it.detailPath,
            language:it.language
          }); 
        }
      }catch(_){}
    }
    res.json({ok:true, data:out});
  }catch(e){ fail(res,e.message,503,e.message); }
});

app.get('/shorts/trending',async(req,res)=>{ try{ const raw=await engine.apiRequest('POST','/wefeed-mobile-bff/shorts/most-trending',{page:+(req.query.page||1),pageSize:+(req.query.pageSize||20)}); res.json({ok:true,data:stripAdult(raw.data)}); }catch(e){ fail(res,e.message,503,e.message);} });
app.get('/sports/list',async(req,res)=>{ try{ res.json({ok:true,data:await sportsGet('/live/match-list-v5',{sportType:String(req.query.sportType||'football')})}); }catch(e){ fail(res,e.message,503,e.message);} });
app.get('/stream/:subjectId',async(req,res)=>{ try{ res.json({ok:true,data:await streamsOp(req.params.subjectId,+(req.query.se||0),+(req.query.ep||0),req.query.detailPath, req.get('host'))}); }catch(e){ const s=e.message==='NO_MEDIA'?404:503; fail(res,'unavailable',s,e.message);} });

// live sport stream proxy: follows the m3u8 with the right referer and pipes it back.
app.get('/live/sport', async (req,res)=>{
  try{
    const st=String(req.query.sportType||'football').toLowerCase();
    const data=await sportsGet('/live/match-list-v5',{sportType:st,currentTagId:'0'});
    const matches=(data&&data.list)||[];
    const out=matches.map(m=>({
      id:m.id, status:m.status, startTime:m.startTime,
      home:m.team1&&m.team1.name, away:m.team2&&m.team2.name,
      homeScore:m.team1&&m.team1.score, awayScore:m.team2&&m.team2.score,
      playPath:m.playPath||null,
      channels:(m.playSource||[]).map(s=>({title:s.title, path:s.path})),
    }));
    res.json({ok:true, data:out});
  }catch(e){ fail(res,e.message,503,e.message); }
});

try { require("./tg-storage").mount(app); } catch(e){ console.error("tg-storage mount failed:", e.message); }

// Mount stream proxy routes safely
try {
  const _proxy = streamProxy.mount(app, streamsOp, null);
  app.post(["/internal/media", "/api-server/internal/media"], _proxy.mediaHandler);
  app.get("/media/segment/:token", _proxy.segmentHandler);
  app.head("/media/segment/:token", _proxy.segmentHandler);
} catch (e) { console.error("stream-proxy mount failed:", e.message); }

// Self-ping Anti-Sleep mechanism for Render Free Tier
const PORT = process.env.PORT || 8787;
const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.listen(PORT, () => {
  console.log(`moviebox-single listening on port ${PORT}`);

  // Anti-Sleep loop: Ping every 10 minutes to prevent Render from idling
  const PING_INTERVAL = 10 * 60 * 1000;
  setInterval(async () => {
    try {
      const response = await fetch(`${APP_URL}/health`);
      console.log(`[Anti-Sleep] Self ping successful! Status: ${response.status}`);
    } catch (error) {
      console.error('[Anti-Sleep] Self ping failed:', error.message);
    }
  }, PING_INTERVAL);
});

module.exports={app,engine,streamsOp};
