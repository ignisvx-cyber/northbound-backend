import {open} from './crypto.js';
async function gh(token,path,opts={}){
  const r=await fetch('https://api.github.com'+path,{...opts,headers:{accept:'application/vnd.github+json','x-github-api-version':'2022-11-28',authorization:`Bearer ${token}`,...opts.headers}});
  const data=await r.json().catch(()=>null); if(!r.ok) throw new Error(data?.message||`GitHub HTTP ${r.status}`); return data;
}
export function tokenFromBlob(blob){ const o=open(blob); if(!o.token) throw new Error('Conexão GitHub inválida'); return o.token; }
export async function listRepos(token){ return gh(token,'/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'); }
export async function listBranches(token,full){ return gh(token,`/repos/${full}/branches?per_page=100`); }
export async function getTree(token,owner,repo,branch){ const ref=await gh(token,`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`); const commit=await gh(token,`/repos/${owner}/${repo}/git/commits/${ref.object.sha}`); const tree=await gh(token,`/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`); return {headSha:ref.object.sha,baseTreeSha:commit.tree.sha,tree:tree.tree||[]}; }
export async function getFile(token,owner,repo,path,ref){ const d=await gh(token,`/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replaceAll('%2F','/')}?ref=${encodeURIComponent(ref)}`); return d?.content?Buffer.from(d.content,'base64').toString('utf8'):''; }
export async function commitFiles(token,{owner,repo,branch,files,message}){
  const {headSha,baseTreeSha}=await getTree(token,owner,repo,branch); const items=[];
  for(const f of files){ const blob=await gh(token,`/repos/${owner}/${repo}/git/blobs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:f.content,encoding:'utf-8'})}); items.push({path:f.path,mode:'100644',type:'blob',sha:blob.sha}); }
  const tree=await gh(token,`/repos/${owner}/${repo}/git/trees`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({base_tree:baseTreeSha,tree:items})});
  const commit=await gh(token,`/repos/${owner}/${repo}/git/commits`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:message||'NORTHBOUND: atualização',tree:tree.sha,parents:[headSha]})});
  await gh(token,`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({sha:commit.sha,force:false})}); return commit;
}
