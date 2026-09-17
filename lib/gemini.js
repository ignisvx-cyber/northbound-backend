const BASE='https://generativelanguage.googleapis.com/v1beta';
const RETRYABLE=new Set([500,502,503,504]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function retryDelaySeconds(data){
  const details=data?.error?.details||[];
  for(const d of details){
    const raw=d?.retryDelay||d?.retry_delay;
    if(typeof raw==='string'){
      const m=raw.match(/([0-9.]+)s/i);
      if(m)return Math.max(1,Math.ceil(Number(m[1])));
    }
  }
  const raw=String(data?.error?.message||'');
  const m=raw.match(/retry\s+in\s+([0-9.]+)s/i);
  return m?Math.max(1,Math.ceil(Number(m[1]))):null;
}

function extractText(data){
  return (data?.candidates||[])
    .flatMap(c=>c?.content?.parts||[])
    .filter(p=>typeof p?.text==='string'&&!p?.thought)
    .map(p=>p.text)
    .join('')
    .trim();
}

function emptyResponseError(data){
  const candidate=data?.candidates?.[0];
  const finish=String(candidate?.finishReason||'').trim();
  const block=String(data?.promptFeedback?.blockReason||'').trim();
  const usage=data?.usageMetadata||{};
  const thought=Number(usage.thoughtsTokenCount||0);
  const output=Number(usage.candidatesTokenCount||0);
  const detail=[finish&&`motivo: ${finish}`,block&&`bloqueio: ${block}`,(thought||output)&&`tokens: ${thought} raciocínio / ${output} resposta`].filter(Boolean).join('; ');
  const err=new Error(`A IA retornou uma resposta vazia${detail?` (${detail})`:''}. Tente novamente.`);
  err.code='EMPTY_AI_RESPONSE';
  return err;
}

async function callGemini({apiKey,model,payload}){
  let lastErr=null;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),60000);
      let r;
      try{
        r=await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`,{
          method:'POST',
          signal:controller.signal,
          headers:{'content-type':'application/json','x-goog-api-key':apiKey},
          body:JSON.stringify(payload)
        });
      }finally{
        clearTimeout(timer);
      }
      const data=await r.json().catch(()=>({}));
      if(r.ok){
        const text=extractText(data);
        if(text)return text;
        throw emptyResponseError(data);
      }
      const msg=data?.error?.message||`Gemini HTTP ${r.status}`;
      if(r.status===429){
        const wait=retryDelaySeconds(data);
        const err=new Error(`Cota do Gemini atingida${wait?`. Tente novamente em cerca de ${wait}s`:'. Tente novamente em alguns instantes ou verifique o faturamento'}.`);
        err.code='GEMINI_QUOTA';
        err.noFallback=true;
        throw err;
      }
      const err=new Error(msg);
      err.httpStatus=r.status;
      lastErr=err;
      if(!RETRYABLE.has(r.status))throw err;
    }catch(e){
      lastErr=e;
      if(e?.noFallback)throw e;
      if(e?.name==='AbortError'){
        const err=new Error('A IA demorou mais de 60 segundos para responder. Tente novamente.');
        err.code='GEMINI_TIMEOUT';
        lastErr=err;
      }
    }
    if(attempt===0)await sleep(450);
  }
  throw lastErr||new Error('Falha ao consultar o Gemini');
}

export async function geminiText({prompt,system='',model,generationConfig={}}){
  const apiKey=process.env.GEMINI_API_KEY;
  if(!apiKey)throw new Error('GEMINI_API_KEY ausente');
  const primary=model||process.env.GEMINI_MODEL||'gemini-3.8-flash';
  const models=[...new Set([primary,'gemini-3.7-flash','gemini-3.6-flash'])];
  const payload={contents:[{role:'user',parts:[{text:prompt}]}]};
  if(system)payload.systemInstruction={parts:[{text:system}]};
  if(generationConfig&&Object.keys(generationConfig).length)payload.generationConfig=generationConfig;
  let lastErr=null;
  for(const current of models){
    try{return await callGemini({apiKey,model:current,payload});}
    catch(e){
      lastErr=e;
      if(e?.noFallback)throw e;
    }
  }
  const raw=String(lastErr?.message||'').trim();
  if(/high demand|unavailable|overload|temporar/i.test(raw)){
    throw new Error('A IA está temporariamente sobrecarregada. Aguarde alguns segundos e envie novamente.');
  }
  throw lastErr||new Error('Não foi possível obter resposta da IA');
}

export function parseJsonLoose(text){
  const s=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{return JSON.parse(s);}catch{}
  const a=s.indexOf('{'),b=s.lastIndexOf('}');
  if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));
  throw new Error('A IA não retornou JSON válido');
}
