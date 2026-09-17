import crypto from 'node:crypto';
import { json, body, options } from '../lib/http.js';
import { geminiText, parseJsonLoose } from '../lib/gemini.js';
import { tokenFromBlob, getTree, getFile, commitFiles } from '../lib/github.js';

const SYSTEM = `Você é o agente de desenvolvimento NORTHBOUND. Trabalhe em projetos web existentes com mudanças mínimas e seguras. Preserve o estilo do projeto, não invente credenciais, não remova funcionalidades sem solicitação. Antes de editar, considere o código real recebido. Quando solicitado JSON, responda somente JSON válido.`;

function modelName() {
  return process.env.GEMINI_MODEL || 'gemini-3.8-flash';
}

function repoOf(p) {
  return p.repository || p.config?.github || {};
}

async function contextFromRepo(token, { owner, repo, branch }) {
  const t = await getTree(token, owner, repo, branch);
  const paths = t.tree
    .filter(x => x.type === 'blob')
    .map(x => x.path)
    .filter(p => !/(^|\/)(node_modules|dist|build|\.git)\//.test(p))
    .slice(0, 1000);

  const priority = [
    'package.json', 'src/main.tsx', 'src/main.jsx', 'src/App.tsx', 'src/App.jsx',
    'src/index.css', 'src/App.css', 'vite.config.ts', 'vite.config.js'
  ];
  const selected = [...new Set([
    ...priority.filter(p => paths.includes(p)),
    ...paths.filter(p => /^(src\/.*\.(tsx?|jsx?|css|html)|package\.json)$/.test(p)).slice(0, 45),
  ])];

  const files = [];
  for (const path of selected) {
    try {
      const content = await getFile(token, owner, repo, path, branch);
      if (content.length < 140000) files.push({ path, content });
    } catch {}
  }
  return { paths, files };
}

function repoContextText(ctx, max = 500000) {
  return (`ÁRVORE:\n${ctx.paths.join('\n')}\n\nARQUIVOS:\n` +
    ctx.files.map(f => `--- ${f.path}\n${f.content}`).join('\n')).slice(0, max);
}

export default async function handler(req, res) {
  if (options(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { ok: false, reason: 'method' });

  try {
    const p = await body(req);

    if (p.op === 'models') {
      return json(res, 200, { ok: true, models: [modelName()] });
    }

    if (p.op === 'status') {
      return json(res, 200, {
        ok: true,
        connected: Boolean(p.connectionBlob),
        model: modelName(),
        github: null,
        graphify: { enabled: true, dir: 'graphify-out' },
      });
    }

    if (p.op === 'config') {
      if (!p.connectionBlob) return json(res, 400, { ok: false, reason: 'github_not_connected', msg: 'Conecte o GitHub primeiro.' });
      const r = repoOf(p);
      if (!r.owner || !r.repo || !r.branch) return json(res, 400, { ok: false, reason: 'incomplete_github' });
      const token = tokenFromBlob(p.connectionBlob);
      try {
        await getTree(token, r.owner, r.repo, r.branch);
      } catch (e) {
        return json(res, 400, { ok: false, reason: 'branch_inexistente', msg: e.message });
      }
      return json(res, 200, {
        ok: true,
        connected: true,
        branch: r.branch,
        github: { owner: r.owner, repo: r.repo, branch: r.branch, hasToken: true },
        graphify: p.config?.graphify || { enabled: true, dir: 'graphify-out' },
        model: p.config?.model || modelName(),
      });
    }

    if (p.op === 'assistant') {
      const r = repoOf(p);
      let context = '';
      if (p.connectionBlob && r.owner && r.repo && r.branch) {
        try {
          const token = tokenFromBlob(p.connectionBlob);
          const ctx = await contextFromRepo(token, r);
          context = repoContextText(ctx, 260000);
        } catch {}
      }
      const answer = await geminiText({
        system: SYSTEM,
        model: p.model || modelName(),
        prompt: `Responda ao usuário como assistente técnico do projeto. Não diga que fez alterações se não fez.\n\nPEDIDO:\n${p.message || ''}\n\n${context}`,
      });
      return json(res, 200, { ok: true, pending: false, summary: answer, message: answer, sources: [] });
    }

    if (p.op !== 'agent') return json(res, 400, { ok: false, reason: 'unknown_op' });

    const action = p.action;

    if (action === 'improve-prompt') {
      const text = await geminiText({
        system: SYSTEM,
        prompt: `Melhore este pedido de edição de software sem mudar a intenção. Seja específico e curto. Retorne apenas o pedido melhorado.\n\nPEDIDO:\n${p.prompt || ''}`,
        model: p.model || modelName(),
      });
      return json(res, 200, { ok: true, prompt: text, text });
    }

    if (action === 'validate-plan') {
      if (!p.approvedPlan?.id || !p.approvedPlan?.digest) return json(res, 400, { ok: false, reason: 'invalid_plan' });
      return json(res, 200, { ok: true, valid: true });
    }

    if (action === 'cancel-plan') return json(res, 200, { ok: true, cancelled: true });

    if (action === 'job-status' || action === 'run-status' || action === 'recover-run') {
      return json(res, 200, { ok: false, pending: false, reason: 'not_found' });
    }

    if (action === 'analyze-attachments') {
      const names = Array.isArray(p.files) ? p.files.map(f => `${f.name} (${f.type || 'arquivo'})`).join(', ') : '';
      const text = await geminiText({
        system: SYSTEM,
        model: p.model || modelName(),
        prompt: `O usuário anexou estes arquivos: ${names || 'nenhum nome disponível'}. Explique de forma curta o que pode ser feito com eles no contexto de desenvolvimento web.`,
      });
      return json(res, 200, { ok: true, pending: false, summary: text, message: text });
    }

    if (action === 'plan' || action === 'edit') {
      if (!p.connectionBlob) throw new Error('GitHub não conectado');
      const r = repoOf(p);
      if (!r.owner || !r.repo || !r.branch) throw new Error('Repositório incompleto');
      const token = tokenFromBlob(p.connectionBlob);
      const ctx = await contextFromRepo(token, r);

      if (action === 'plan') {
        const plan = await geminiText({
          system: SYSTEM,
          prompt: `Analise o pedido e o projeto. Crie um plano objetivo, numerado, com arquivos prováveis e validações. Não escreva código ainda.\n\nPEDIDO:\n${p.message || ''}\n\n${repoContextText(ctx, 430000)}`,
          model: p.model || modelName(),
        });
        const id = crypto.randomUUID();
        return json(res, 200, {
          ok: true,
          pending: false,
          plan: {
            id,
            revision: 1,
            digest: crypto.createHash('sha256').update(plan).digest('hex'),
            text: plan,
          },
          text: plan,
          message: plan,
          summary: plan,
        });
      }

      const prompt = `Você vai editar um projeto existente. Retorne SOMENTE JSON válido no formato {"summary":"...","commitMessage":"...","files":[{"path":"src/...","content":"arquivo completo"}]}. Inclua somente arquivos que realmente precisam mudar. Cada content deve conter o arquivo COMPLETO depois da alteração. Não use markdown.\n\nPEDIDO:\n${p.message || ''}\n\n${p.approvedPlan?.text ? `PLANO APROVADO:\n${p.approvedPlan.text}\n\n` : ''}${repoContextText(ctx, 500000)}`;
      const raw = await geminiText({ system: SYSTEM, prompt, model: p.model || modelName() });
      const out = parseJsonLoose(raw);
      if (!Array.isArray(out.files) || !out.files.length) throw new Error('A IA não retornou arquivos para alterar');
      for (const f of out.files) {
        if (!f?.path || typeof f.content !== 'string') throw new Error('A IA retornou alteração inválida');
        if (/(^|\/)\.git\//.test(f.path) || /(^|\/)node_modules\//.test(f.path)) throw new Error('A IA tentou alterar caminho não permitido');
      }

      const commit = await commitFiles(token, {
        ...r,
        files: out.files,
        message: out.commitMessage || 'NORTHBOUND: atualização',
      });
      return json(res, 200, {
        ok: true,
        pending: false,
        summary: out.summary || 'Alteração concluída.',
        message: out.summary || 'Alteração concluída.',
        commitSha: commit.sha,
        commitUrl: `https://github.com/${r.owner}/${r.repo}/commit/${commit.sha}`,
        files: out.files.map(f => f.path),
      });
    }

    return json(res, 400, { ok: false, reason: 'unsupported_action', msg: `Ação ainda não implementada: ${action}` });
  } catch (e) {
    return json(res, 500, { ok: false, reason: 'backend_error', msg: e.message });
  }
}
