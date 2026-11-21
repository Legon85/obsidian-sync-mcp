import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const MAX_BYTES = 8 * 1024 * 1024;
const EXTENSIONS = new Set(['jpg','jpeg','png','webp','gif','avif']);
const uploadPath = /^\/attachments\/upload\/([A-Za-z0-9_-]{43})$/;

function validateDestination(path) {
  if (typeof path !== 'string' || !path.startsWith('Assets/') || path.length > 240) throw Error('Destination must be a path inside Assets/');
  const parts = path.split('/');
  if (parts.length < 2 || parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || /[\\\x00-\x1f]/.test(p))) throw Error('Unsafe destination path');
  const ext = parts.at(-1).split('.').at(-1)?.toLowerCase();
  if (!EXTENSIONS.has(ext)) throw Error('Allowed formats: jpg, jpeg, png, webp, gif, avif');
  return ext;
}
function isPublicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && b >= 18 && b <= 19) return false;
  if (a === 192 && (b === 0 || b === 88 && c === 99 || b === 0 && c === 2) || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113) return false;
  return true;
}
function inferType(bytes) {
  if (bytes.length > 8 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length > 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'webp';
  if (bytes.length > 6 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))) return 'gif';
  if (bytes.length > 12 && bytes.toString('ascii',4,8) === 'ftyp' && ['avif','avis'].includes(bytes.toString('ascii',8,12))) return 'avif';
  return null;
}
async function fetchPublicImage(src) {
  const url = new URL(src);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || isIP(url.hostname)) throw Error('A public HTTPS URL without credentials is required');
  const answers = await lookup(url.hostname, { family: 4, all: true });
  const ip = answers.find(x => isPublicIPv4(x.address));
  if (!ip) throw Error('Host has no permitted public IPv4 address');
  return await new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method:'GET', timeout:15000, maxRedirects:0, headers:{'Accept':'image/avif,image/webp,image/png,image/jpeg,image/gif','User-Agent':'Obsidian-Knowledge-Hub-Attachments/1.0'}, lookup:(_host,_options,callback)=>callback(null,ip.address,4)}, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(Error(`Image server HTTP ${res.statusCode}; redirects are not followed`)); return; }
      const headerLen = Number(res.headers['content-length']);
      if (Number.isFinite(headerLen) && headerLen > MAX_BYTES) { res.destroy(); reject(Error('Image exceeds 8 MiB')); return; }
      let size=0; const chunks=[];
      res.on('data',chunk=>{size+=chunk.length; if(size>MAX_BYTES){res.destroy(Error('Image exceeds 8 MiB'));return;}chunks.push(chunk);});
      res.on('end',()=>{if(!size){reject(Error('Image is empty'));return;}resolve(Buffer.concat(chunks,size));});
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(Error('Image download timeout')));
    req.on('error',reject);
    req.end();
  });
}
async function sendUpload(data,token) {
  const url=`http://mcp-writer:8787/attachments/upload/${token}`;
  return await new Promise((resolve,reject)=>{
    const req=httpRequest(url,{method:'PUT',timeout:30000,headers:{'Content-Type':'application/octet-stream','Content-Length':data.length}},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>16000){res.destroy(Error('Upload response too large'));return;}chunks.push(chunk);});
      res.on('end',()=>{const body=Buffer.concat(chunks).toString('utf8');if(res.statusCode!==201){reject(Error(`Writer HTTP ${res.statusCode}: ${body.slice(0,200)}`));return;}try{resolve(JSON.parse(body));}catch{reject(Error('Writer returned invalid JSON'));}});
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(Error('Writer upload timeout')));
    req.on('error',reject);
    req.end(data);
  });
}
function toolText(value){return typeof value==='string'?value:JSON.stringify(value);}
export async function callAttachmentBridge(name,args,callWriterTool){
  if(name==='list_image_attachments'){
    const result=await callWriterTool('list_attachments',{folder:'Assets',limit:100});
    return toolText(result);
  }
  if(name==='get_image_metadata'){
    validateDestination(args?.path);
    return toolText(await callWriterTool('get_attachment_metadata',{path:args.path}));
  }
  if(name!=='download_attachment_from_url') throw Error('Unknown image operation');
  const path=args?.path,url=args?.url;
  const ext=validateDestination(path);
  const data=await fetchPublicImage(url);
  const detected=inferType(data);
  if(!detected || !([ext,ext==='jpg'?'jpeg':ext].includes(detected))) throw Error(`File signature mismatch (expected ${ext}, received ${detected||'unknown'})`);
  const response=await callWriterTool('create_attachment_upload',{path,size:data.length,overwrite:args?.overwrite===true});
  const raw=toolText(response);
  const matches=[...raw.matchAll(/https?:\/\/[^\s'"<>\\]+\/attachments\/upload\/[A-Za-z0-9_-]{43}/g)];
  if(!matches.length) throw Error(`Writer did not return an upload URL; check ATTACHMENTS_ENABLED. ${raw.slice(0,180)}`);
  const u=new URL(matches[0][0]);
  const match=u.pathname.match(uploadPath);
  if(!match) throw Error('Invalid upload handle');
  const saved=await sendUpload(data,match[1]);
  if(saved.path!==path || saved.size!==data.length) throw Error('Writer upload verification mismatch');
  return JSON.stringify({ok:true,path,size:saved.size,sha256:createHash('sha256').update(data).digest('hex'),embed:`![[${path}]]`});
}
