'use strict';
const crypto = require('crypto');
const express = require('express');
const streamProxy = require('./moviebox-stream-proxy');

const SECRET_DEFAULT_B64 = 'NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==';
const SECRET_ALT_B64 = 'WHFuMm5uTzQxL0w5Mm8xaXVYaFNMSFRiWHZZNFo1Wlo2Mm04bVNMQQ==';
const MODERN_UA = 'com.community.mbox.in/50020130 (Linux; U; Android 14; en_IN; Pixel 8; Build/UD1A.230803.041; Cronet/145.0.7582.0)';

const ADULT_TAGS = /(^|,s*)(erotic|hot|adult|aiadult|18+|xxx|porn|nude|nsfw)(s*,|$)/i;
function isAdultGenre(genre){ return !!genre && ADULT_TAGS.test(String(genre)); }
function isAdultSubject(x){
  if(!x || typeof x !== 'object') return false;
  const g = x.genre || (x.subject && x.subject.genre) || x.tag || '';
  return isAdultGenre(g);
}
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
    return { subject_id:String(data.subjectId), title:data.title, subject_type:data.subjectType, type:data.subjectType===1?'Movie':'Series', description:data.description, release_date:data.releaseDate, duration:data.duration, imdb_rating:data.imdbRatingValue, genre:data.genre, country:data.countryName, language:data.language, cover:(data.cover&&data.cover.url)||null, detail_path:dp };
  }
  async getStreams(subjectId, season=0, episode=0, detailPath=null){
    if(!detailPath){ try{ detailPath=(await this.getDetails(subjectId)).detail_path||''; }catch(e){ detailPath=''; } }
    const token = await this.bootstrapToken();
    const streams=[]; const seen=new Set();
    const q=(resStr)=>{ let v=0; for(const n of [2160,1440,1080,720,480,360,240]) if(String(resStr).includes(String(n))){v=n;break;} return v; };
    for(const domain of WEB_DOMAINS){
      const playUrl = `${domain}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${season}&ep=${episode}&detailPath=${detailPath}&streamSignType=1&supportCodecs%5Bhevc%5D=1&supportCodecs%5Bh264%5D=1`;
      const referer = `${domain}/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=&detailEp=&lang=en`;
      const headers = { 'User-Agent':WEB_UA, Referer:referer, Accept:'application/json', 'x-client-info':'{"timezone":"Asia/Calcutta"}', Authorization:'Bearer '+token };
      try{
        const r = await fetch(playUrl,{headers}); if(r.status!==200) continue;
        const data=(await r.json()).data||{}; const raw=data.streams||[];
        for(const st of raw){ if(!st.url||seen.has(st.url))continue; seen.add(st.url); const sb=parseInt(st.size||0); const qv=q(st.resolutions);
          streams.push({ source:'Web CDN', format:st.format||'MP4', quality:qv?qv+'p':'HD', quality_value:qv, url:st.url, size_bytes:sb||null, codec:st.codecName, duration_sec:st.duration, headers:{'User-Agent':WEB_UA,Referer:'https://moviebox.ph/',Origin:'https://moviebox.ph'} }); 
        }
        break;
      }catch(e){ continue; }
    }
    streams.sort((a,b)=>b.quality_value-a.quality_value);
    return streams;
  }
  async getSubtitles(subjectId, streamId=0, season=0, episode=0){
    return [];
  }
}

const SPORTS_HEADERS={'Referer':'https://sportsnow.top/','Origin':'https://sportsnow.top','User-Agent':'Mozilla/5.0','Accept':'application/json'};
async function sportsGet(path, params={}){ const qs=new URLSearchParams(params).toString(); const r=await fetch(SPORTS_BASE+path+(qs?'?'+qs:''),{headers:SPORTS_HEADERS}); const j=await r.json(); if(j.code!==0) throw new Error('UPSTREAM_REJECTED'); return j.data; }

const engine = new MovieBoxEngine();
const app = express();
app.use(express.json({limit:'1mb'}));

const fail=(res,message,status=503,code='UNAVAILABLE')=>res.status(status).json({ok:false,error:message,code});

// 🟢 دائریکٹ اسٹریم اور ڈاؤن لوڈ لنکس بنانے والا ماسٹر فنکشن
async function streamsOp(subjectId, season=0, episode=0, detailPath, req){
  if(!/^\d+$/.test(subjectId)) throw new Error('INVALID_REQUEST');
  const rows = await engine.getStreams(subjectId, season, episode, detailPath||null);
  if(!rows.length) throw new Error('NO_MEDIA');
  
  const PORT = process.env.PORT || 8787;
  const HOST = (req && req.get('host')) || process.env.RENDER_EXTERNAL_URL?.replace(/^https?:\/\//,'') || `localhost:${PORT}`;
  const PROTOCOL = HOST.includes('localhost') ? 'http' : 'https';
  const BASE_URL = `${PROTOCOL}://${HOST}`;

  const out=[];
  for(const row of rows){
    if(!row.url) continue;
    let fmt=String(row.format||'mp4').toLowerCase();
    let quality=parseInt(row.quality_value||0);
    let size=row.size_bytes;
    const headers={...(row.headers||{})};

    // پراکسی ٹوکن جنریٹ کرنا
    const token = streamProxy.remember(row.url, headers);
    
    // ۱. اسٹریم لنک (براؤزر میں پلے کرنے کے لیے)
    const streamUrl = `${BASE_URL}/media/segment/${token}`;
    
    // ۲. ڈاؤن لوڈ لنک (ڈائریکٹ فائل ڈاؤن لوڈ کرنے کے لیے - download=1 کا فلیگ)
    const downloadUrl = `${BASE_URL}/media/segment/${token}?download=1`;

    out.push({ 
      resourceId: String(out.length), 
      resolution: quality, 
      format: fmt, 
      sizeBytes: size, 
      duration: row.duration_sec||0, 
      codecName: row.codec||'', 
      streamUrl: streamUrl,   // 👈 ڈائریکٹ پلے کرنے کے لیے
      downloadUrl: downloadUrl // 👈 ڈائریکٹ ڈاؤن لوڈ کرنے کے لیے
    });
  }
  if(!out.length) throw new Error('NO_MEDIA');
  return out;
}

app.get('/health',(req,res)=>res.json({ok:true,service:'moviebox-single'}));

app.get('/movies/search',async(req,res)=>{
  const q=String(req.query.q||''), page=+(req.query.page||1);
  try{ 
    const resList = await engine.search(q,page);
    return res.json({ok:true, data: resList});
  }catch(e){ fail(res,e.message,503,e.message); }
});

app.get('/stream/:subjectId',async(req,res)=>{ 
  try{ 
    const data = await streamsOp(req.params.subjectId, +(req.query.se||0), +(req.query.ep||0), req.query.detailPath, req);
    res.json({ok:true, data}); 
  }catch(e){ 
    const s=e.message==='NO_MEDIA'?404:503; 
    fail(res,'unavailable',s,e.message);
  } 
});

// اسٹریمنگ پروکسی ماؤنٹ کرنا
try {
  const _proxy = streamProxy.mount(app, (id, se, ep) => streamsOp(id, se, ep, null, null), null);
  app.get("/media/segment/:token", _proxy.segmentHandler);
  app.head("/media/segment/:token", _proxy.segmentHandler);
} catch (e) { console.error("stream-proxy mount failed:", e.message); }

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Zaidi API Hub is running live on port ${PORT}`);
});

module.exports={app,engine,streamsOp};
