# CMDBuild Docker Compose

Local CMDBuild 4.1.0 deployment with PostgreSQL/PostGIS.

## Start

Create a local environment file:

```sh
cp .env.example .env
```

Edit `.env` and set `POSTGRES_PASSWORD` before running the stack.

```sh
docker compose up -d
```

CMDBuild can take several minutes to initialize the demo database on the first run.

If Docker was installed through Snap and the daemon socket is owned by
`root:root`, run this once before starting the stack:

```sh
sudo addgroup --system docker || true
sudo adduser "$USER" docker
sudo snap disable docker
sudo snap enable docker
sudo setfacl -m "u:$USER:rw" /var/run/docker.sock
```

## URLs

- CMDBuild: http://localhost:8090/cmdbuild
- CMDBuild external: http://SERVER_IP:8090/cmdbuild
- Tomcat: http://localhost:8090/

## Credentials

- CMDBuild administrator: `admin` / `admin`
- Tomcat manager: `admin` / `password`
- PostgreSQL superuser: `postgres` / `postgres`
- PostgreSQL application user: `cmdbuild` / `cmdbuild`

The loaded CMDBuild demo database contains active users `admin`, `mdavis`,
`pjones`, and `workflow`. Only `admin` / `admin` is verified as a working
login in this stack.

## Operations

```sh
docker compose ps
docker compose logs -f
docker compose down
```

## FastAPI frontend

The local Python frontend uses FastAPI with Jinja templates and reads classes
from the CMDBuild REST API after login.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000
```

- Frontend: http://localhost:8000/
- External frontend: http://SERVER_IP:8000/

To reset all CMDBuild data:

```sh
docker compose down -v
docker compose up -d
```
