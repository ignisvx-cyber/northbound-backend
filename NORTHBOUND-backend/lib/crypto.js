import crypto from 'node:crypto';
function key(){
  const s=process.env.CONNECTION_SECRET||'';
  if(s.length<32) throw new Error('CONNECTION_SECRET ausente ou curto');
  return crypto.createHash('sha256').update(s).digest();
}
export function seal(obj){
  const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);
  const p=Buffer.concat([cipher.update(JSON.stringify(obj),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag(); return Buffer.concat([iv,tag,p]).toString('base64url');
}
export function open(blob){
  const b=Buffer.from(String(blob||''),'base64url'); if(b.length<29) throw new Error('connectionBlob inválido');
  const iv=b.subarray(0,12), tag=b.subarray(12,28), p=b.subarray(28);
  const d=crypto.createDecipheriv('aes-256-gcm',key(),iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(p),d.final()]).toString('utf8'));
}
export function signState(payload){
  const data=Buffer.from(JSON.stringify({...payload,exp:Date.now()+10*60*1000})).toString('base64url');
  const sig=crypto.createHmac('sha256',key()).update(data).digest('base64url'); return data+'.'+sig;
}
export function verifyState(state){
  const [data,sig]=String(state||'').split('.');
  const want=crypto.createHmac('sha256',key()).update(data||'').digest('base64url');
  if(!sig || !crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(want))) throw new Error('state inválido');
  const p=JSON.parse(Buffer.from(data,'base64url').toString('utf8')); if(Date.now()>p.exp) throw new Error('state expirado'); return p;
}
