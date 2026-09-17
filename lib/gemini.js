const BASE='https://generativelanguage.googleapis.com/v1beta';
const RETRYABLE=new Set([429,500,502,503,504]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function callGemini({apiKey,model,payload}){
  let lastErr=null;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),45000);
      const r=await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',signal:controller.signal,headers:{'content-type':'application/json','x-goog-api-key':apiKey},body:JSON.stringify(payload)});
      clearTimeout(timer);
      const data=await r.json().catch(()=>({}));
      if(r.ok){const text=(data.candidates||[]).flatMap(c=>c?.content?.parts||[]).map(p=>p.text||'').join('').trim();if(text)return text;throw new Error('Gemini retornou resposta vazia');}
      lastErr=new Error(data?.error?.message||`Gemini HTTP ${r.status}`);
      if(!RETRYABLE.has(r.status))throw lastErr;
    }catch(e){lastErr=e;}
    if(attempt===0)await sleep(350);
  }
  throw lastErr||new Error('Falha ao consultar o Gemini');
}

export async function geminiText({prompt,system='',model}){
  const apiKey=process.env.GEMINI_API_KEY;if(!apiKey)throw new Error('GEMINI_API_KEY ausente');
  const primary=model||process.env.GEMINI_MODEL||'gemini-3.8-flash';
  const models=[...new Set([primary,'gemini-3.7-flash','gemini-3.6-flash'])];
  const payload={contents:[{role:'user',parts:[{text:prompt}]}]};if(system)payload.systemInstruction={parts:[{text:system}]};
  let lastErr=null;
  for(const current of models){try{return await callGemini({apiKey,model:current,payload});}catch(e){lastErr=e;}}
  const raw=String(lastErr?.message||'').trim();
  if(/high demand|unavailable|overload|temporar/i.test(raw))throw new Error('A IA está temporariamente sobrecarregada. A NORTHBOUND tentou modelos alternativos; aguarde alguns segundos e envie novamente.');
  throw lastErr||new Error('Não foi possível obter resposta da IA');
}

export function parseJsonLoose(text){const s=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');try{return JSON.parse(s);}catch{}const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));throw new Error('A IA não retornou JSON válido');}
