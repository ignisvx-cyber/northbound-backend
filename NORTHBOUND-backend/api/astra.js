import crypto from 'node:crypto'; import {json,body,options} from '../lib/http.js'; import {geminiText,parseJsonLoose} from '../lib/gemini.js'; import {tokenFromBlob,getTree,getFile,commitFiles} from '../lib/github.js';
const SYSTEM=`Você é o agente de desenvolvimento NORTHBOUND. Trabalhe em projetos web existentes com mudanças mínimas e seguras. Preserve o estilo do projeto, não invente credenciais, não remova funcionalidades sem solicitação. Quando solicitado JSON, responda somente JSON válido.`;
function repoOf(p){return p.repository||{};}
async function contextFromRepo(token,{owner,repo,branch}){
  const t=await getTree(token,owner,repo,branch); const paths=t.tree.filter(x=>x.type==='blob').map(x=>x.path).filter(p=>!/(^|\/)(node_modules|dist|build|\.git)\//.test(p)).slice(0,800);
  const priority=['package.json','src/main.tsx','src/main.jsx','src/App.tsx','src/App.jsx','src/index.css','src/App.css','vite.config.ts','vite.config.js']; const selected=[...new Set([...priority.filter(p=>paths.includes(p)),...paths.filter(p=>/^(src\/.*\.(tsx?|jsx?|css)|package\.json)$/.test(p)).slice(0,35)])];
  const files=[]; for(const path of selected){ try{ const content=await getFile(token,owner,repo,path,branch); if(content.length<120000)files.push({path,content}); }catch{} }
  return {paths,files};
}
export default async function handler(req,res){
  if(options(req,res))return; if(req.method!=='POST')return json(res,405,{ok:false,reason:'method'});
  try{ const p=await body(req);
    if(p.op==='models') return json(res,200,{ok:true,models:[{id:process.env.GEMINI_MODEL||'gemini-3.8-flash',name:'NORTHBOUND Flash'}]});
    if(p.op!=='agent') return json(res,400,{ok:false,reason:'unknown_op'});
    const action=p.action;
    if(action==='improve-prompt'){
      const text=await geminiText({system:SYSTEM,prompt:`Melhore este pedido de edição de software sem mudar a intenção. Seja específico e curto. Retorne apenas o pedido melhorado.\n\nPEDIDO:\n${p.prompt||''}`,model:p.model});
      return json(res,200,{ok:true,prompt:text,text});
    }
    if(action==='plan' || action==='edit'){
      if(!p.connectionBlob) throw new Error('GitHub não conectado'); const r=repoOf(p); if(!r.owner||!r.repo||!r.branch)throw new Error('Repositório incompleto'); const token=tokenFromBlob(p.connectionBlob); const ctx=await contextFromRepo(token,r);
      if(action==='plan'){
        const plan=await geminiText({system:SYSTEM,prompt:`Analise o pedido e o projeto. Crie um plano objetivo, numerado, com arquivos prováveis e validações. Não escreva código ainda.\nPEDIDO: ${p.message||''}\nÁRVORE:\n${ctx.paths.join('\n')}\nARQUIVOS:\n${ctx.files.map(f=>`--- ${f.path}\n${f.content}`).join('\n').slice(0,450000)}`,model:p.model});
        const id=crypto.randomUUID(); return json(res,200,{ok:true,pending:false,plan:{id,revision:1,digest:crypto.createHash('sha256').update(plan).digest('hex'),text:plan},text:plan,message:plan});
      }
      const prompt=`Você vai editar um projeto. Retorne SOMENTE JSON no formato {"summary":"...","commitMessage":"...","files":[{"path":"src/...","content":"arquivo completo"}]}. Inclua somente arquivos alterados. Não use markdown.\nPEDIDO:\n${p.message||''}\n${p.approvedPlan?.text?`PLANO APROVADO:\n${p.approvedPlan.text}\n`:''}ÁRVORE:\n${ctx.paths.join('\n')}\nARQUIVOS DISPONÍVEIS:\n${ctx.files.map(f=>`--- ${f.path}\n${f.content}`).join('\n').slice(0,520000)}`;
      const raw=await geminiText({system:SYSTEM,prompt,model:p.model}); const out=parseJsonLoose(raw); if(!Array.isArray(out.files)||!out.files.length)throw new Error('A IA não retornou arquivos para alterar');
      const commit=await commitFiles(token,{...r,files:out.files,message:out.commitMessage||'NORTHBOUND: atualização'}); return json(res,200,{ok:true,pending:false,summary:out.summary||'Alteração concluída.',message:out.summary||'Alteração concluída.',commitSha:commit.sha,commitUrl:commit.html_url||null,files:out.files.map(f=>f.path)});
    }
    if(action==='job-status'||action==='run-status') return json(res,200,{ok:false,pending:false,reason:'not_found'});
    return json(res,400,{ok:false,reason:'unsupported_action',msg:`Ação ainda não implementada: ${action}`});
  }catch(e){ json(res,500,{ok:false,reason:'backend_error',msg:e.message}); }
}
