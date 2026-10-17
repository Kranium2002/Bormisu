"""alignments

Planned lines (tunnel, pipeline, drilling line) uploaded as GeoJSON, KML, GPX or CSV (contract 1.3.0
`Alignment`): the line as a WGS84 MultiLineString with its ellipsoidal length and the default search
distance. Revises 0005: 0006 is the users and sessions migration of the auth branch, which is not on
main yet; when it lands, this migration's down_revision becomes 0006.

Revision ID: 0007
Revises: 0005
Create Date: 2026-10-17 19:40:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from geoalchemy2 import Geometry

# revision identifiers, used by Alembic.
revision: str = "0007"
down_revision: str | Sequence[str] | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_geospatial_table(
        "alignments",
        sa.Column("id", sa.String(length=40), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("file_name", sa.Text(), nullable=False),
        sa.Column("format", sa.String(length=10), nullable=False),
        sa.Column("source_crs", sa.String(length=40), nullable=False),
        sa.Column(
            "geom",
            Geometry(
                geometry_type="MULTILINESTRING",
                srid=4326,
                dimension=2,
                spatial_index=False,
                from_text="ST_GeomFromEWKT",
                name="geometry",
                nullable=False,
            ),
            nullable=False,
        ),
        sa.Column("length_m", sa.Float(), nullable=False),
        sa.Column("vertex_count", sa.Integer(), nullable=False),
        sa.Column("part_count", sa.Integer(), nullable=False),
        sa.Column("buffer_m", sa.Float(), server_default=sa.text("100"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_alignments")),
    )
    op.create_geospatial_index(
        "idx_alignments_geom",
        "alignments",
        ["geom"],
        unique=False,
        postgresql_using="gist",
        postgresql_ops={},
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_geospatial_index(
        "idx_alignments_geom", table_name="alignments", postgresql_using="gist", column_name="geom"
    )
    op.drop_geospatial_table("alignments")
