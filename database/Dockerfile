# Investment Dashboard - Postgres image
#
# Bakes the schema (and optional seed data) into the image itself via
# /docker-entrypoint-initdb.d, so the container is self-contained and
# doesn't depend on a bind-mounted init folder. That matters if you deploy
# this to ECS/Fargate or anywhere else that isn't your local docker-compose
# setup: `docker run` (or a task definition) with just this image and a
# persistent volume for PGDATA is enough to get a fully migrated database.
#
# The init scripts only run the FIRST time a container starts against an
# empty data directory. Rebuilding the image after schema changes will not
# retroactively migrate an existing volume - see database/README.md.

FROM postgres:16-alpine

COPY init/ /docker-entrypoint-initdb.d/

# Sensible defaults; override at `docker run`/compose time.
ENV POSTGRES_DB=investment_dashboard \
    POSTGRES_USER=investment_dashboard \
    PGDATA=/var/lib/postgresql/data/pgdata

EXPOSE 5432
