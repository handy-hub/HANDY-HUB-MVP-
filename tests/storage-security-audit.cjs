/* Adversarial Firebase Storage emulator probe. Audit evidence only. */
const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
const project = process.env.GCLOUD_PROJECT || 'lamax-4fd82';
const bucket = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG).storageBucket : `${project}.appspot.com`;
const base = `http://${host}/v0/b/${bucket}/o`;

const auth = {};
async function createUser(key,email) {
  const r=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'Audit-pass-123!',returnSecureToken:true})});
  const d=await r.json(); if(!r.ok) throw new Error(JSON.stringify(d)); auth[key]=d.idToken; return d.localId;
}
const headers = who => who ? {Authorization:`Bearer ${auth[who]}`} : {};
const obj = p => `${base}/${encodeURIComponent(p)}`;
async function upload(path, who, body='JPEG', type='image/jpeg') {
  const bytes=Buffer.isBuffer(body)?body:Buffer.from(body);
  const start=await fetch(`${base}?name=${encodeURIComponent(path)}`, {method:'POST',headers:{...headers(who),'Content-Type':'application/json; charset=UTF-8','X-Goog-Upload-Protocol':'resumable','X-Goog-Upload-Command':'start','X-Goog-Upload-Header-Content-Length':String(bytes.length),'X-Goog-Upload-Header-Content-Type':type},body:JSON.stringify({name:path,contentType:type})});
  if(!start.ok) return start;
  return fetch(start.headers.get('x-goog-upload-url'),{method:'POST',headers:{...headers(who),'Content-Type':'application/octet-stream','X-Goog-Upload-Command':'upload, finalize','X-Goog-Upload-Offset':'0'},body:bytes});
}
async function read(path, who, tokenParam='') { return fetch(`${obj(path)}?alt=media${tokenParam}`, {headers:headers(who)}); }
async function del(path, who) { return fetch(obj(path), {method:'DELETE',headers:headers(who)}); }
async function list(prefix, who) { return fetch(`${base}?prefix=${encodeURIComponent(prefix)}`, {headers:headers(who)}); }
async function log(name, expected, fn) {
  try { const r=await fn(); const text=(await r.text()).slice(0,240).replace(/\s+/g,' '); console.log(JSON.stringify({attack:name,expected,actualStatus:r.status,body:text})); return r; }
  catch(e) { console.log(JSON.stringify({attack:name,expected,actualStatus:'NETWORK_ERROR',body:e.message})); }
}
(async()=>{
  const ids={};
  ids.artisanA=await createUser('artisanA','a@example.test');
  ids.artisanB=await createUser('artisanB','b@example.test');
  ids.customerA=await createUser('customerA','c@example.test');
  ids.admin=await createUser('admin','silas7korda@gmail.com');
  console.log(JSON.stringify({evidence:'auth',ids,claims:Object.fromEntries(Object.entries(auth).map(([k,v])=>[k,JSON.parse(Buffer.from(v.split('.')[1],'base64url'))]))}));
  const p=`artisans/${ids.artisanB}/documents/idFront.jpg`;
  await log('setup: artisan B uploads own KYC','200',()=>upload(p,'artisanB'));
  await log('1 unauthenticated read KYC','403',()=>read(p));
  await log('2 customer A reads artisan B KYC','403',()=>read(p,'customerA'));
  await log('3 artisan A reads artisan B KYC','403',()=>read(p,'artisanA'));
  await log('4 unauthenticated write','403',()=>upload(`artisans/${ids.artisanB}/documents/anon.jpg`,null));
  await log('5a user A overwrites user B file','403',()=>upload(p,'artisanA','EVIL'));
  await log('5b user A deletes user B file','403',()=>del(p,'artisanA'));
  await log('6 path escape to another uid namespace','403',()=>upload(`artisans/${ids.artisanB}/documents/traversal.jpg`,'artisanA'));
  await log('7 list bucket path not owned','403',()=>list(`artisans/${ids.artisanB}/documents/`,'artisanA'));
  await log('8 SVG script upload to image-accepted KYC','expected reject',()=>upload(`artisans/${ids.artisanA}/documents/xss.svg`,'artisanA','<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>','image/svg+xml'));
  const over=Buffer.alloc(5*1024*1024+1,0x41);
  await log('9 oversized KYC upload','403',()=>upload(`artisans/${ids.artisanA}/documents/oversize.jpg`,'artisanA',over));
  await log('11 legitimate artisan uploads own KYC','200',()=>upload(`artisans/${ids.artisanA}/documents/idFront.jpg`,'artisanA'));
  await log('12 legitimate admin reads KYC','200',()=>read(p,'admin'));
  const meta=await fetch(obj(p),{headers:headers('artisanB')}); const md=await meta.json().catch(()=>({}));
  const dl=md.downloadTokens ? `&token=${String(md.downloadTokens).split(',')[0]}` : '';
  await log('10 unauthenticated token URL delivery','200 if token minted',()=>read(p,null,dl));
  console.log(JSON.stringify({evidence:'metadata',downloadTokens:md.downloadTokens||null,name:md.name||null}));
})().catch(e=>{console.error(e);process.exitCode=1});
