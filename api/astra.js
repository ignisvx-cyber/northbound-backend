import crypto from 'node:crypto';
import { json, body, options } from '../lib/http.js';
import { geminiText, parseJsonLoose } from '../lib/gemini.js';
import { tokenFromBlob, getTree, getFile, commitFiles } from '../lib/github.js';

const SYSTEM=`Você é o agente de desenvolvimento NORTHBOUND. Trabalhe diretamente em projetos web existentes. Preserve o estilo e faça mudanças mínimas e seguras. Quando o usuário pede uma alteração concreta, execute a alteração no projeto em vez de pedir autorização para abrir ou editar arquivos. Você já tem autorização para consultar os arquivos necessários do repositório conectado. Só peça esclarecimento quando existirem duas interpretações realmente incompatíveis e nenhuma puder ser inferida do projeto. Nunca diga que alterou algo sem commit. Quando solicitado JSON, responda somente JSON válido.`;
const LOW_THINK={thinkingConfig:{thinkingLevel:'LOW'}};
const STYLE_REQUEST=/(cor|cores|vermelh|azul|verde|tema|theme|background|fundo|estilo|style|css|fonte|tipografia|layout|apar[eê]ncia|visual)/i;
const EDIT_REQUEST=/(mude|mudar|altere|alterar|troque|trocar|remova|remover|retire|tirar|adicione|adicionar|inclua|incluir|crie|criar|fa[çc]a|corrija|corrigir|conserte|ajuste|atualize|edite|implemente|transforme|delete|remove|change|update|add|create|fix|edit|implement|replace)/i;

function modelName(){return process.env.GEMINI_MODEL||'gemini-3.8-flash'}
function repoOf(p){return p.repository||p.config?.github||{}}
function normalize(s=''){return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')}
function isEditRequest(s=''){return EDIT_REQUEST.test(String(s))}

function scorePath(path,request=''){
  const q=normalize(request),pp=normalize(path);let s=0;
  if(/^(src\/)?(app|main|index)\.(tsx?|jsx?|html|css)$/.test(pp))s+=12;
  if(/(^|\/)(styles?|globals?|index|app|main)\.(css|scss|sass|less)$/.test(pp))s+=28;
  if(/(^|\/)(app|layout|root)\.(tsx?|jsx?)$/.test(pp))s+=12;
  if(/package\.json$/.test(pp))s+=3;
  if(STYLE_REQUEST.test(request)&&/\.(css|scss|sass|less)$/.test(pp))s+=35;
  if(STYLE_REQUEST.test(request)&&/(tailwind|theme|style|global|index|app)/.test(pp))s+=14;
  const words=[...new Set(q.match(/[a-z0-9_-]{4,}/g)||[])].filter(w=>!['remover','todos','todas','botao','botoes','alterar','mudar','quero','para','pelo','pela','relacionados','pagina','toda','todo','fazer'].includes(w));
  for(const w of words)if(pp.includes(w))s+=14;
  if(/src\/(components|pages|sections)\//.test(pp))s+=4;
  return s;
}

function directlyNamedPaths(paths,request=''){
  const q=String(request);
  return paths.filter(p=>q.includes(p)||q.includes(p.split('/').at(-1))).slice(0,8);
}

async function contextFromRepo(token,{owner,repo,branch},request='',limit=14){
  const t=await getTree(token,owner,repo,branch);
  const paths=t.tree.filter(x=>x.type==='blob').map(x=>x.path).filter(p=>!/(^|\/)(node_modules|dist|build|\.git|public\/assets)\//.test(p)).slice(0,1200);
  const candidates=paths.filter(p=>/\.(tsx?|jsx?|css|scss|sass|less|html|json)$/.test(p)&&!/(package-lock|bun\.lock|yarn\.lock)/.test(p));
  const pinned=[];
  pinned.push(...directlyNamedPaths(candidates,request));
  if(STYLE_REQUEST.test(request))pinned.push(...candidates.filter(p=>/(^|\/)(styles?|globals?|index|app|main)\.(css|scss|sass|less)$/.test(normalize(p))).slice(0,8));
  const ranked=[...candidates].sort((a,b)=>scorePath(b,request)-scorePath(a,request));
  const selected=[...new Set([...pinned,...ranked])].slice(0,limit);
  const loaded=await Promise.all(selected.map(async path=>{try{const content=await getFile(token,owner,repo,path,branch);return content.length<90000?{path,content}:null}catch{return null}}));
  return{paths,files:loaded.filter(Boolean)};
}

async function loadExtraFiles(token,r,ctx,needFiles=[]){
  const allowed=new Set(ctx.paths);
  const wanted=[...new Set((needFiles||[]).map(String).filter(p=>allowed.has(p)))].slice(0,8);
  const have=new Set(ctx.files.map(f=>f.path));
  const extra=await Promise.all(wanted.filter(p=>!have.has(p)).map(async path=>{try{const content=await getFile(token,r.owner,r.repo,path,r.branch);return content.length<120000?{path,content}:null}catch{return null}}));
  ctx.files.push(...extra.filter(Boolean));
  return ctx;
}

function repoContextText(ctx,max=180000){
  return(`ÁRVORE DO REPOSITÓRIO:\n${ctx.paths.join('\n')}\n\nARQUIVOS ABERTOS NESTA ETAPA:\n`+ctx.files.map(f=>`--- ${f.path}\n${f.content}`).join('\n')).slice(0,max);
}

async function editWithContext({token,r,request,model}){
  const ctx=await contextFromRepo(token,r,request,18);
  const schema='{"summary":"resumo curto","commitMessage":"NORTHBOUND: ...","files":[{"path":"caminho","content":"ARQUIVO COMPLETO após a alteração"}],"needFiles":[]}';
  const first=await geminiText({system:SYSTEM,model,generationConfig:{...LOW_THINK,responseMimeType:'application/json',maxOutputTokens:65536,temperature:0.1},prompt:`Execute o pedido do usuário no código. NÃO peça autorização para consultar arquivos e NÃO faça perguntas apenas porque um arquivo ainda não foi aberto.\n\nSe os arquivos abertos forem suficientes, retorne os arquivos alterados completos. Se faltar um arquivo necessário que aparece na ÁRVORE, não converse com o usuário: coloque o caminho exato em needFiles e deixe files vazio.\n\nRetorne SOMENTE JSON neste formato: ${schema}\n\nPEDIDO:\n${request}\n\n${repoContextText(ctx,190000)}`});
  let out=parseJsonLoose(first);

  if((!Array.isArray(out.files)||!out.files.length)&&Array.isArray(out.needFiles)&&out.needFiles.length){
    await loadExtraFiles(token,r,ctx,out.needFiles);
    const second=await geminiText({system:SYSTEM,model,generationConfig:{...LOW_THINK,responseMimeType:'application/json',maxOutputTokens:65536,temperature:0.1},prompt:`Agora você recebeu os arquivos adicionais que pediu. EXECUTE a alteração. Não peça confirmação e não devolva needFiles novamente. Retorne SOMENTE JSON no formato ${schema}, com files contendo somente os arquivos realmente alterados e com o conteúdo COMPLETO de cada arquivo.\n\nPEDIDO:\n${request}\n\n${repoContextText(ctx,230000)}`});
    out=parseJsonLoose(second);
  }

  if(!Array.isArray(out.files)||!out.files.length)throw new Error('A IA não produziu uma alteração concreta para aplicar.');
  for(const f of out.files){
    if(!f?.path||typeof f.content!=='string')throw new Error('A IA retornou alteração inválida');
    if(!ctx.paths.includes(f.path))throw new Error(`A IA tentou alterar um caminho inexistente: ${f.path}`);
    if(/(^|\/)(\.git|node_modules)\//.test(f.path))throw new Error('Caminho não permitido');
  }
  const commit=await commitFiles(token,{...r,files:out.files,message:out.commitMessage||'NORTHBOUND: atualização'});
  const summary=String(out.summary||'Alteração concluída.').trim()||'Alteração concluída.';
  const changes=out.files.map(f=>({path:f.path,status:'update'}));
  return{ok:true,pending:false,conversationOnly:false,intent:'codex',summary,message:summary,commitSha:commit.sha,commitUrl:`https://github.com/${r.owner}/${r.repo}/commit/${commit.sha}`,changes,files:out.files.map(f=>f.path),sources:[]};
}

async function planWithContext({token,r,request,model}){
  const ctx=await contextFromRepo(token,r,request,12);
  return geminiText({system:SYSTEM,model,generationConfig:{...LOW_THINK,maxOutputTokens:8192},prompt:`Crie um plano CURTO e executável para este pedido. Se o alvo puder ser identificado pelo código, assuma a interpretação natural e não peça esclarecimento.\n\nPEDIDO:\n${request}\n\n${repoContextText(ctx,120000)}`});
}

export default async function handler(req,res){
  if(options(req,res))return;
  if(req.method!=='POST')return json(res,405,{ok:false,reason:'method'});
  try{
    const p=await body(req);
    if(p.op==='models')return json(res,200,{ok:true,models:[modelName()]});
    if(p.op==='status')return json(res,200,{ok:true,connected:Boolean(p.connectionBlob),model:modelName(),github:null,graphify:{enabled:true,dir:'graphify-out'}});
    if(p.op==='config'){
      if(!p.connectionBlob)return json(res,400,{ok:false,reason:'github_not_connected',msg:'Conecte o GitHub primeiro.'});
      const r=repoOf(p);if(!r.owner||!r.repo||!r.branch)return json(res,400,{ok:false,reason:'incomplete_github'});
      await getTree(tokenFromBlob(p.connectionBlob),r.owner,r.repo,r.branch);
      return json(res,200,{ok:true,connected:true,branch:r.branch,github:{owner:r.owner,repo:r.repo,branch:r.branch,hasToken:true},graphify:p.config?.graphify||{enabled:true,dir:'graphify-out'},model:p.config?.model||modelName()});
    }

    if(p.op==='assistant'){
      const r=repoOf(p),request=String(p.message||'').trim(),mode=p.mode||'auto',model=p.model||modelName();
      const shouldEdit=mode==='build'||(mode==='auto'&&isEditRequest(request));
      if(shouldEdit){
        if(!p.connectionBlob)throw new Error('GitHub não conectado');
        if(!r.owner||!r.repo||!r.branch)throw new Error('Repositório incompleto');
        const result=await editWithContext({token:tokenFromBlob(p.connectionBlob),r,request,model});
        return json(res,200,result);
      }
      if(mode==='plan'&&p.connectionBlob&&r.owner&&r.repo&&r.branch){
        const plan=await planWithContext({token:tokenFromBlob(p.connectionBlob),r,request,model});
        return json(res,200,{ok:true,pending:false,intent:'plan',summary:plan,message:plan,sources:[]});
      }
      let context='';
      if(p.connectionBlob&&r.owner&&r.repo&&r.branch){try{const ctx=await contextFromRepo(tokenFromBlob(p.connectionBlob),r,request,8);context=repoContextText(ctx,90000)}catch{}}
      const answer=await geminiText({system:SYSTEM,model,generationConfig:{...LOW_THINK,maxOutputTokens:4096},prompt:`Responda de forma objetiva ao usuário sobre o projeto. Este modo é de conversa, então não afirme ter editado arquivos.\n\nPEDIDO:\n${request}\n\n${context}`});
      return json(res,200,{ok:true,pending:false,intent:'chat',summary:answer,message:answer,sources:[]});
    }

    if(p.op!=='agent')return json(res,400,{ok:false,reason:'unknown_op'});
    const action=p.action;
    if(action==='validate-plan')return json(res,200,{ok:true,valid:true});
    if(action==='cancel-plan')return json(res,200,{ok:true,cancelled:true});
    if(['job-status','run-status','recover-run'].includes(action))return json(res,200,{ok:false,pending:false,reason:'not_found'});
    if(action==='analyze-attachments')return json(res,200,{ok:true,pending:false,summary:'Anexos recebidos. Posso usá-los como referência para a alteração.',message:'Anexos recebidos. Posso usá-los como referência para a alteração.'});
    if(action==='improve-prompt')return json(res,410,{ok:false,reason:'removed',msg:'O recurso Melhorar prompt foi removido da NORTHBOUND.'});

    if(action==='plan'||action==='edit'){
      if(!p.connectionBlob)throw new Error('GitHub não conectado');
      const r=repoOf(p);if(!r.owner||!r.repo||!r.branch)throw new Error('Repositório incompleto');
      const token=tokenFromBlob(p.connectionBlob),request=p.message||p.prompt||'',model=p.model||modelName();
      if(action==='plan'){
        const plan=await planWithContext({token,r,request,model});
        const id=crypto.randomUUID();
        return json(res,200,{ok:true,pending:false,plan,planApproval:{id,revision:1,digest:crypto.createHash('sha256').update(plan).digest('hex'),status:'pending'},text:plan,message:plan,summary:plan});
      }
      return json(res,200,await editWithContext({token,r,request,model}));
    }

    return json(res,400,{ok:false,reason:'unsupported_action',msg:`Ação ainda não implementada: ${action}`});
  }catch(e){
    const code=e?.code||'';
    if(code==='GEMINI_QUOTA')return json(res,429,{ok:false,reason:'cota_esgotada',msg:e.message});
    if(code==='GEMINI_TIMEOUT')return json(res,504,{ok:false,reason:'ia_demorou',msg:e.message});
    if(code==='EMPTY_AI_RESPONSE')return json(res,502,{ok:false,reason:'empty_ai_response',msg:e.message});
    return json(res,500,{ok:false,reason:'backend_error',msg:e.message});
  }
}
