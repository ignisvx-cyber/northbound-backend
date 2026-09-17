const BASE='https://generativelanguage.googleapis.com/v1beta';
export async function geminiText({prompt,system='',model}){
  const apiKey=process.env.GEMINI_API_KEY; if(!apiKey) throw new Error('GEMINI_API_KEY ausente');
  model=model||process.env.GEMINI_MODEL||'gemini-3.8-flash';
  const payload={contents:[{role:'user',parts:[{text:prompt}]}]};
  if(system) payload.systemInstruction={parts:[{text:system}]};
  const r=await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':apiKey},body:JSON.stringify(payload)});
  const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(data?.error?.message||`Gemini HTTP ${r.status}`);
  return (data.candidates||[]).flatMap(c=>c?.content?.parts||[]).map(p=>p.text||'').join('').trim();
}
export function parseJsonLoose(text){
  const s=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{return JSON.parse(s);}catch{}
  const a=s.indexOf('{'), b=s.lastIndexOf('}'); if(a>=0&&b>a) return JSON.parse(s.slice(a,b+1));
  throw new Error('A IA não retornou JSON válido');
}
