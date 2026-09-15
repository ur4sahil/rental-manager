#!/usr/bin/env node
/**
 * Compares what is in Housify against what the CURRENT-TENANT scope would
 * have imported, and lists anything outside it.
 *
 * The importer walked every file under a matched property folder, including
 * Lease/<Tenant>-OLD/. That was wrong: Sahil asked for current tenants only.
 * This finds the rows that should not be there. It DELETES nothing unless
 * --delete is passed.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const ROOT = process.env.DROPBOX_ROOT || path.join(process.env.HOME, "Dropbox");
const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const COMPANY = argv("--company");
const DELETE = args.includes("--delete");

const parseAddr = (s) => {
  const t = String(s||"").toLowerCase().replace(/,/g," ").replace(/\s+/g," ").trim();
  const num=(t.match(/^\s*(\d+)/)||[])[1]||"";
  let unit=(t.match(/(?:unit|apt|ste|suite|#)\s*([\w-]+)/)||[])[1]||"";
  if(!unit){const m=t.match(/\b(\d+-\d+)\b/);if(m&&m[1]!==num)unit=m[1];}
  const street=t.replace(/^\s*\d+\s*/,"").replace(/(?:unit|apt|ste|suite|#)\s*[\w-]+/g," ")
   .replace(/\b(md|va|dc|maryland|virginia)\b/g," ").replace(/\b\d{5}(-\d{4})?\b/g," ")
   .replace(/\b(street|st|road|rd|drive|dr|court|ct|lane|ln|place|pl|avenue|ave|circle|cir|terrace|ter|way|boulevard|blvd|park)\b/g," ")
   .replace(/[^a-z0-9]/g,"");
  return {num,unit:unit.replace(/[^a-z0-9]/g,""),street};
};
const lev=(a,b)=>{const m=a.length,n=b.length;if(!m||!n)return Math.max(m,n);let p=[...Array(n+1).keys()],c=[];
 for(let i=1;i<=m;i++){c=[i];for(let j=1;j<=n;j++)c[j]=Math.min(p[j]+1,c[j-1]+1,p[j-1]+(a[i-1]===b[j-1]?0:1));p=c;}return p[n];};
const addrMatch=(a,b)=>{const A=parseAddr(a),B=parseAddr(b);if(!A.num||A.num!==B.num)return false;
 const tol=Math.max(2,Math.floor(Math.min(A.street.length,B.street.length)*0.25));
 if(lev(A.street,B.street)>tol)return false;if(A.unit&&B.unit&&A.unit!==B.unit)return false;return true;};

(async()=>{
 const sb=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
 const {data:props}=await sb.from("properties").select("id,address").eq("company_id",COMPANY).is("archived_at",null);
 const folders=fs.readdirSync(ROOT).filter(f=>{try{return fs.statSync(path.join(ROOT,f)).isDirectory()&&!f.startsWith(".");}catch{return false;}});

 // classify every source file by scope
 const IMPORTABLE=/\.(pdf|jpg|jpeg|png|gif|webp|doc|docx|xls|xlsx|txt|csv)$/i;
 const scopeOf=new Map();   // basename -> Set(scopes) ; basenames repeat, so keep all
 const add=(k,v)=>{const s=scopeOf.get(k)||new Set();s.add(v);scopeOf.set(k,s);};
 const walk=(dir,rel="")=>{
  let e;try{e=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const x of e){
   if(x.name.startsWith(".")||x.name.startsWith("~$"))continue;
   const fp=path.join(dir,x.name);
   if(x.isDirectory()){walk(fp,rel?rel+"/"+x.name:x.name);continue;}
   if(!IMPORTABLE.test(x.name))continue;
   const segs=rel?rel.split("/"):[];
   let scope="property-level";
   if(/^lease$/i.test(segs[0]||"")){
    if(segs[1]&&/-old\s*$/i.test(segs[1])) scope="OLD-TENANT";
    else if(segs[1]) scope="current-tenant";
    else scope="lease-root";
   }
   add(x.name.toLowerCase(),scope);
  }
 };
 for(const p of props){const f=folders.find(x=>addrMatch(p.address,x));if(f)walk(path.join(ROOT,f));}

 // what is actually imported
 const docs=[];
 for(let from=0;;from+=1000){
  const {data,error}=await sb.from("documents").select("id,name,file_name,property,tenant,type,uploaded_at")
   .eq("company_id",COMPANY).gte("uploaded_at",new Date(Date.now()-6*3600e3).toISOString()).range(from,from+999);
  if(error)throw error;docs.push(...data);if(data.length<1000)break;
 }
 const base=(n)=>String(n).replace(/^.*?\s—\s/,"").toLowerCase();
 const tally={};const offenders=[];
 for(const d of docs){
  const s=scopeOf.get(base(d.name));
  let scope = !s ? "unknown" : (s.has("current-tenant")?"current-tenant":(s.has("OLD-TENANT")?"OLD-TENANT":[...s][0]));
  tally[scope]=(tally[scope]||0)+1;
  if(scope==="OLD-TENANT") offenders.push(d);
 }
 console.log(`documents imported in this session: ${docs.length}\n`);
 Object.entries(tally).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${String(v).padStart(4)}  ${k}`));
 console.log(`\nout of scope (old tenants): ${offenders.length}`);
 offenders.slice(0,10).forEach(o=>console.log(`  - ${o.name.slice(0,66)}  [${o.tenant||"no tenant"}]`));

 if(DELETE && offenders.length){
  let removed=0;
  for(const o of offenders){
   await sb.storage.from("documents").remove([o.file_name]);
   const {error}=await sb.from("documents").delete().eq("id",o.id).eq("company_id",COMPANY);
   if(!error)removed++;
  }
  console.log(`\ndeleted ${removed} out-of-scope documents (row + stored file)`);
 } else if(offenders.length){
  console.log(`\nre-run with --delete to remove them`);
 }
})().catch(e=>{console.error("FAILED:",e.message);process.exit(1);});
