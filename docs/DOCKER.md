# Docker

Guia completo para rodar o QwenProxy em containers.

- [Início rápido](#início-rápido)
- [Comandos úteis](#comandos-úteis)
- [Configuração](#configuração)
- [Volumes e persistência](#volumes-e-persistência)
- [Recursos e limites](#recursos-e-limites)
- [Usando `docker run` direto](#usando-docker-run-direto)
- [Bind mounts](#bind-mounts)
- [Troubleshooting](#troubleshooting)
- [Compatibilidade](#compatibilidade)

---

## Início rápido

Requisitos: **Docker 20.10+** e **Docker Compose v2** (`docker compose`, não `docker-compose`).

```bash
# 1. Clone e entre na pasta
git clone https://github.com/pedrofariasx/qwenproxy.git
cd qwenproxy

# 2. Crie o arquivo de configuração
cp .env.example .env
nano .env          # defina API_KEY e as credenciais QWEN_EMAIL/QWEN_PASSWORD

# 3. Suba
docker compose up -d

# 4. Acompanhe
docker compose logs -f
```

O servidor responde em `http://localhost:3000` e o painel admin em `http://localhost:3000/admin`.

Comandos npm equivalentes (verificam a versão do Playwright antes de agir):

```bash
npm run docker:up       # build + up
npm run docker:logs     # logs em tempo real
npm run docker:down     # derruba
```

> **Sem `.env`?** O `docker compose up` falha com `Couldn't find env file: .env`.
> Copie o exemplo: `cp .env.example .env`.

---

## Comandos úteis

| Ação | Comando |
| --- | --- |
| Build + subir | `npm run docker:up` |
| Subir (sem rebuild) | `docker compose up -d` |
| Rebuild da imagem | `npm run docker:build` |
| Ver logs | `npm run docker:logs` |
| Reiniciar | `npm run docker:restart` |
| Shell no container | `npm run docker:shell` |
| Status + health | `npm run docker:health` |
| Derrubar | `npm run docker:down` |
| Derrubar **e apagar os volumes** | `npm run docker:clean` ⚠️ |
| Validar versão do Playwright | `npm run docker:verify` |

> `docker:clean` apaga o banco SQLite e todos os perfis de navegador. Use com cuidado.

---

## Configuração

Toda a configuração vem do `.env`, montado na raiz do projeto e injetado via `env_file`.

```bash
cp .env.example .env
```

### Variáveis que mais importam no Docker

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `PORT` | `3000` | Porta do servidor. Publishada no host **e** dentro do container. |
| `API_KEY` | vazio | Chave de `Authorization` para `/v1/*`. **Defina em produção.** |
| `ADMIN_PASSWORD` | fallback `API_KEY` | Senha do painel `/admin`. |
| `QWEN_EMAIL` / `QWEN_PASSWORD` | vazio | Credenciais para auto-login das contas. |
| `BROWSER` | `chromium` | `chromium`, `firefox`, `webkit`, `chrome` ou `edge`. |
| `USER_DATA_DIR` | `/app/qwen_profiles` | Onde os perfis de navegador são gravados (montado como volume). |
| `PUID` / `PGID` | vazio | IDs do usuário do host, para bind mounts. Ver [Bind mounts](#bind-mounts). |
| `DOCKER_MEMORY_LIMIT` | `4g` | Limite de memória do container. |
| `DOCKER_CPUS` | `2.0` | Limite de CPUs do container. |
| `DOCKER_SHM_SIZE` | `1gb` | Tamanho de `/dev/shm`. O Chromium **quebra** com o padrão de 64MB. |
| `DOCKER_TMPFS_SIZE` | `1073741824` | Tamanho do tmpfs em `/tmp` (1 GiB). |

### Sobrescrever valores sem editar o `.env`

```bash
PORT=8080 DOCKER_MEMORY_LIMIT=8g docker compose up -d
```

---

## Volumes e persistência

| Volume | Caminho no container | Conteúdo |
| --- | --- | --- |
| `qwenproxy_data` | `/app/data` | Banco SQLite: contas, API keys, sessões, cooldowns |
| `qwenproxy_profiles` | `/app/qwen_profiles` | Perfis de navegador por conta (cookies, sessão do Qwen) |

O entrypoint ajusta a permissão dos volumes no startup. Se o container sair com
`is not writable`, veja [Troubleshooting](#troubleshooting).

Para inspecionar o conteúdo:

```bash
docker compose exec qwenproxy ls -la /app/data
docker compose exec qwenproxy ls -la /app/qwen_profiles
```

### Backup

```bash
docker compose exec qwenproxy tar czf - -C /app/data . > qwenproxy-data-$(date +%F).tar.gz
```

Para restaurar, suba o container, copie o arquivo de volta e reinicie:

```bash
docker compose up -d
docker cp qwenproxy-data-2026-10-21.tar.gz qwenproxy:/tmp/restore.tar.gz
docker compose exec qwenproxy sh -c 'cd /app/data && tar xzf /tmp/restore.tar.gz'
docker compose restart
```

---

## Recursos e limites

Cada contexto do Chromium consome **~300–600 MB** de RAM. Dimensione pela
quantidade de contas/lanes:

| Contas | RAM recomendada | CPUs |
| --- | --- | --- |
| 1–2 | 2 GB | 1 |
| 3–5 | 4 GB | 2 |
| 6–10 | 8 GB | 3–4 |

```bash
DOCKER_MEMORY_LIMIT=8g DOCKER_CPUS=4 docker compose up -d
```

> Os limites são declarados com `mem_limit`/`cpus` (Compose v2), **não** com
> `deploy.resources` — que é ignorado fora do Swarm e causava o container a
> rodar sem limite nenhum.

### `shm_size` é obrigatório

O Chromium usa `/dev/shm` para IPC e **crasha** com o default de 64 MB do
Docker. O compose já define `shm_size: 1gb`.

---

## Usando `docker run` direto

Sem o Compose:

```bash
docker build -t qwenproxy:local .

docker run -d \
  --name qwenproxy \
  -p 3000:3000 \
  --shm-size=1gb \
  --memory=4g \
  --cpus=2 \
  --stop-timeout=30 \
  --restart unless-stopped \
  -v qwenproxy_data:/app/data \
  -v qwenproxy_profiles:/app/qwen_profiles \
  --env-file .env \
  qwenproxy:local
```

A imagem já traz `HEALTHCHECK`, então `docker ps` mostra `(healthy)` e
`docker inspect` expõe o estado de saúde.

---

## Bind mounts

Em vez dos volumes nomeados, é possível apontar para diretórios do host:

```bash
mkdir -p ~/qwenproxy/data ~/qwenproxy/profiles

docker run -d --name qwenproxy \
  -p 3000:3000 --shm-size=1gb \
  -v ~/qwenproxy/data:/app/data \
  -v ~/qwenproxy/profiles:/app/qwen_profiles \
  --env-file .env \
  qwenproxy:local
```

Diretórios do host pertencem ao seu usuário. Para o container escrever neles,
informe os IDs:

```bash
# no .env
PUID=$(id -u)
PGID=$(id -g)
```

O entrypoint remapeia a conta `pwuser` da imagem para esses IDs e ajusta a
permissão dos diretórios montados. Se o ID já estiver em uso dentro da imagem,
o container **falha com uma mensagem explícita** em vez de rodar com a
permissão errada.

---

## Troubleshooting

### `Couldn't find env file: .env`

O Compose exige o arquivo. Crie a partir do exemplo:

```bash
cp .env.example .env
```

### `Error: /app/data is not writable by pwuser`

O volume já existia com outra ownership. Force a correção:

```bash
docker compose down
docker volume rm qwenproxy_qwenproxy_data
docker volume rm qwenproxy_qwenproxy_profiles
docker compose up -d
```

Com bind mounts, use `PUID`/`PGID` (veja [Bind mounts](#bind-mounts)).

### `Executable doesn't exist at /ms-playwright/...`

A versão do Playwright no `package.json` divergiu da imagem. A imagem traz os
binários do navegador **exatamente** da sua versão. Verifique e alinhe:

```bash
npm run docker:verify
```

O script compara `package.json`, o `ARG PLAYWRIGHT_VERSION` do Dockerfile e o
argumento do `docker-compose.yml`. Se divergirem, atualize os dois arquivos
junto com a dependência. O CI falha o build quando há divergência.

### O container reinicia em loop

Veja os logs: `docker compose logs --tail=100`. As causas mais comuns:

- **Memória insuficiente** — o Chromium é被杀 pelo OOM killer. Aumente
  `DOCKER_MEMORY_LIMIT`.
- **`/dev/shm` pequeno** — confirme `shm_size: 1gb` no compose.
- **Porta em uso** — `address already in use`. Mude `PORT` ou libere a porta.

### O healthcheck falha

`/health` só responde **depois** do boot completo (pré-captura dos headers de
todas as contas, com stagger). Com várias contas isso leva minutos:

```bash
docker compose logs --tail=50   # acompanhe o progresso
docker inspect --format='{{json .State.Health}}' $(docker compose ps -q)
```

O `start_period` é de 120s — increma-o no compose se você usa muitas contas.

### A porta publicada não responde

O compose publica **a mesma porta** dos dois lados (`${PORT}:${PORT}`). Se o
`.env` define `PORT=3001` mas o comando usa o default, o mapeamento quebra.
Use sempre `docker compose up -d` a partir da pasta do projeto, para que o
`.env` seja lido.

Para conferir:

```bash
docker compose ps        # deve mostrar 0.0.0.0:3000->3000/tcp
```

### Quero ver o que o Chromium está fazendo

```bash
docker compose exec qwenproxy sh -c 'ls -la /app/qwen_profiles'
docker compose exec qwenproxy sh -c 'cat /app/data/qwenproxy.db' | head
```

### Reiniciar do zero

```bash
npm run docker:clean    # derruba e APAGA os volumes
```

---

## Compatibilidade

### Docker Compose

| Recurso | Mínimo |
| --- | --- |
| Docker Engine | 20.10 |
| Docker Compose | v2.0 (`docker compose`) |

O `docker-compose.yml` usa apenas recursos do Compose v2 (`mem_limit`, `cpus`,
`stop_grace_period`, `shm_size`). O `env_file` usa a forma de lista simples
para funcionar também em instalações mais antigas — a forma com `path:`/
`required:` exigiria Compose v2.24+.

### Playwright

A imagem base é `mcr.microsoft.com/playwright:v<versão>-noble`, que já inclui
Chromium, Firefox, WebKit e todas as dependências de sistema. O argumento
`PLAYWRIGHT_VERSION` **precisa** acompanhar a dependência `playwright` do
`package.json` — é o que garante que os binários do navegador existam.

```dockerfile
ARG PLAYWRIGHT_VERSION=1.60.0
```

### Recursos do host

- **x86_64 ou arm64** — a imagem oficial tem ambas.
- **`/dev/shm`** — ver `shm_size`.
- **Cgroups v2** — suportado.

### Limitações conhecidas

- **Não roda em serverless** (Vercel, Netlify, Cloud Run sem container): exige
  Chromium e disco persistente.
- **`--privileged` não é necessário** — o Chromium roda com `--no-sandbox` e
  `no-new-privileges`.
- **Persistência de sessão** depende dos volumes: sem eles, cada restart exige
  novo login.
