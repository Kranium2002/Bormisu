# PostgreSQL 16 + PostGIS 3.5 + pgvector for GeoMemory.
# Extensions (postgis, vector, ...) are created by the first Alembic migration, not by init scripts,
# so every database (dev, test, CI) gets the same schema through the same path.
FROM postgis/postgis:16-3.5

# postgis/postgis:16-3.5 is built on Debian 11 (bullseye), which the PostgreSQL apt repository has
# moved to its archive (apt.postgresql.org answers 404 for bullseye-pgdg). On bullseye only, point
# the existing PGDG source (same signing key) at apt-archive.postgresql.org.
RUN . /etc/os-release \
    && if [ "$VERSION_CODENAME" = "bullseye" ]; then \
         sed -i 's#https\?://apt\.postgresql\.org/#https://apt-archive.postgresql.org/#' \
           /etc/apt/sources.list.d/pgdg.list; \
       fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-pgvector \
    && rm -rf /var/lib/apt/lists/*
