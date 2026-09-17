import crypto from 'node:crypto';
import { json, body, options } from '../lib/http.js';
import { seal, signState, verifyState } from '../lib/crypto.js';
import { listRepos, listBranches, tokenFromBlob } from '../lib/github.js';

function mapRepo(r) {
  return {
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    private: r.private,
    default_branch: r.default_branch,
    owner: r.owner?.login,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
  };
}

export default async function handler(req, res) {
  if (options(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { ok: false, reason: 'method' });

  try {
    const p = await body(req);
    const op = p.op;

    if (op === 'start') {
      if (!process.env.GITHUB_CLIENT_ID) throw new Error('GITHUB_CLIENT_ID ausente');
      const state = signState({ nonce: crypto.randomUUID() });
      const redirect = process.env.GITHUB_REDIRECT_URI || '';
      const u = new URL('https://github.com/login/oauth/authorize');
      u.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
      u.searchParams.set('scope', 'repo read:user');
      u.searchParams.set('state', state);
      if (redirect) u.searchParams.set('redirect_uri', redirect);
      return json(res, 200, { ok: true, url: u.toString(), state });
    }

    if (op === 'finish') {
      verifyState(p.state);
      const r = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code: p.code,
          redirect_uri: process.env.GITHUB_REDIRECT_URI || undefined,
        }),
      });
      const d = await r.json();
      if (!d.access_token) throw new Error(d.error_description || 'GitHub não retornou token');

      const headers = {
        authorization: `Bearer ${d.access_token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      };
      const meResp = await fetch('https://api.github.com/user', { headers });
      const me = await meResp.json();
      if (!meResp.ok || !me?.login) throw new Error(me?.message || 'Não foi possível ler a conta GitHub');

      const repos = await listRepos(d.access_token);
      const connectionBlob = seal({ token: d.access_token, login: me.login, id: me.id });
      return json(res, 200, {
        ok: true,
        connectionBlob,
        account: me.login,
        repositories: repos.map(mapRepo),
      });
    }

    if (op === 'repositories') {
      const token = tokenFromBlob(p.connectionBlob);
      const repos = await listRepos(token);
      return json(res, 200, { ok: true, repositories: repos.map(mapRepo) });
    }

    if (op === 'branches') {
      const token = tokenFromBlob(p.connectionBlob);
      const branches = await listBranches(token, p.full_name);
      return json(res, 200, { ok: true, branches: branches.map(b => b.name) });
    }

    if (op === 'disconnect') return json(res, 200, { ok: true });
    return json(res, 400, { ok: false, reason: 'unknown_op' });
  } catch (e) {
    return json(res, 400, { ok: false, reason: 'github_error', msg: e.message });
  }
}
