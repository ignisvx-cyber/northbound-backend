# NORTHBOUND backend (Vercel)

Backend independente para a edição NORTHBOUND. A chave Gemini **não fica na extensão**.

## Variáveis de ambiente

- `GEMINI_API_KEY` — chave criada no Google AI Studio.
- `GEMINI_MODEL` — por padrão `gemini-3.8-flash`.
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — OAuth App GitHub da NORTHBOUND.
- `GITHUB_REDIRECT_URI` — callback usado pelo fluxo da extensão.
- `CONNECTION_SECRET` — string aleatória de 32+ caracteres para criptografar tokens GitHub.

## Endpoints

- `GET /api/health`
- `POST /api/astra`
- `POST /api/github-app-connect`

A implementação inicial já oferece modelos, refinamento de prompt, plano, edição + commit e conexão GitHub. O Supabase OAuth e recursos avançados do executor Astra antigo ainda não estão implementados nesta primeira etapa.

## Segurança

Nunca inclua `.env.local` ou a chave Gemini no ZIP da extensão. Configure os secrets diretamente no provedor de hospedagem.
