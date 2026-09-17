export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'POST,GET,OPTIONS');
  res.end(JSON.stringify(body));
}
export async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw=''; for await (const c of req) raw += c;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
export function options(req,res){ if(req.method==='OPTIONS'){ json(res,200,{ok:true}); return true;} return false; }
