"""Turn herrenknecht-projects.json into projects.js for the world map slide.

Adds each project's world-atlas country id (matched by name), so world.js can light the country up.
Run from this folder:  python3 build_projects.py [input.json]
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
ATLAS = HERE.parent / 'vendor' / 'countries-110m.js'

# our country names -> world-atlas 110m names
ALIASES = {
    'United States': 'United States of America', 'USA': 'United States of America', 'US': 'United States of America',
    'UK': 'United Kingdom', 'England': 'United Kingdom', 'Scotland': 'United Kingdom', 'Wales': 'United Kingdom',
    'Czech Republic': 'Czechia', 'United Arab Emirates (UAE)': 'United Arab Emirates', 'UAE': 'United Arab Emirates',
    'Hong Kong': 'China', 'Macau': 'China', 'North Macedonia': 'Macedonia', 'Bosnia and Herzegovina': 'Bosnia and Herz.',
    'Dominican Republic': 'Dominican Rep.', 'Korea': 'South Korea', 'Republic of Korea': 'South Korea',
    'Russian Federation': 'Russia', 'Türkiye': 'Turkey', 'Viet Nam': 'Vietnam', 'Ivory Coast': "Côte d'Ivoire",
    'Democratic Republic of the Congo': 'Dem. Rep. Congo', 'Eswatini': 'eSwatini',
}


def main(src: Path) -> None:
    atlas = json.loads(ATLAS.read_text()[len('window.WORLD = '):].rstrip().rstrip(';'))
    ids = {g['properties']['name']: g.get('id') for g in atlas['objects']['countries']['geometries']}
    data = json.loads(src.read_text())
    unmatched = []
    for p in data['projects']:
        name = ALIASES.get(p['country'], p['country'])
        p['atlas_id'] = ids.get(name)
        if p['atlas_id'] is None:
            unmatched.append(p['country'])  # e.g. Singapore: too small for the 110m map, still gets its dots
        p['machines'] = max(1, int(p.get('machines') or 1))
    (HERE / 'projects.js').write_text('window.HK_PROJECTS = ' + json.dumps(data, ensure_ascii=False, indent=1) + ';\n')
    dots = sum(p['machines'] for p in data['projects'])
    countries = len({p['country'] for p in data['projects']})
    print(f"{len(data['projects'])} projects, {countries} countries, {dots} dots")
    if unmatched:
        print('no map polygon for:', sorted(set(unmatched)))


if __name__ == '__main__':
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / 'herrenknecht-projects.json')
